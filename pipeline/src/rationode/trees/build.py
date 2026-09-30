"""Build decision trees per decision type and scope, and write them to Neo4j.

Tree kinds:
    BEHAVIOR  learned: context -> option chosen (what an actor does)
    OUTCOME   learned: context + action -> outcome (what leads where)
    POLICY    hand-entered from the written policy; real decisions routed through it

Every leaf is a DecisionPoint. Behavior and policy leaves fan out with BRANCH
edges to the Options actually chosen there, carrying share and outcome rates.
Decisions attach to their leaf with AT_POINT.
"""

from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone

from neo4j import Driver

from rationode.trees.learner import ALGORITHM_VERSION, Feature, Node, TreeLearner

COST_OUTCOMES = ("refund_cost", "dispute_won", "dispute_lost")
EVIDENCE_ITEMS = ("usage_logs", "tos_acceptance", "cancellation_emails", "delivery_confirmation")

# ---------------------------------------------------------------- written policies (demo spec: policy vs reality)
POLICY_TREES = {
    "charge.fraud_screen": {
        "policy": ("fraud-screening", "2025.1"),
        "text": "Review charges with risk score 60 or above; decline above 90; approve the rest.",
        "tree": {"split": ("charge.risk_score", ">=", 60),
                 "left": {"split": ("charge.risk_score", ">", 90), "left": {"option": "decline"}, "right": {"option": "review"}},
                 "right": {"option": "approve"}},
    },
    "support.complaint_resolution": {
        "policy": ("streamly-refunds", "2025.1"),
        "text": "Full refund for billing errors; otherwise a voucher up to $100 and a partial refund above $100.",
        "tree": {"split": ("support.complaint_category", "IN", ["billing_error"]),
                 "left": {"option": "full_refund"},
                 "right": {"split": ("support.amount_usd", ">", 100), "left": {"option": "partial_refund"},
                           "right": {"option": "voucher"}}},
    },
    "dispute.response": {
        "policy": ("streamly-disputes", "2025.1"),
        "text": "Contest disputes over $50; accept disputes of $50 or less.",
        "tree": {"split": ("dispute.amount_usd", ">", 50), "left": {"option": "contest"}, "right": {"option": "accept"}},
    },
}


def holds(x: dict, cond: tuple) -> bool:
    attr, op, val = cond
    v = x.get(attr)
    if v is None:
        return False
    return {">=": lambda: v >= val, ">": lambda: v > val, "<": lambda: v < val, "<=": lambda: v <= val,
            "=": lambda: v == val, "IN": lambda: v in val, "NOT IN": lambda: v not in val}[op]()


def negate(cond: tuple) -> tuple:
    attr, op, val = cond
    return (attr, {">=": "<", ">": "<=", "<": ">=", "<=": ">", "=": "!=", "IN": "NOT IN", "NOT IN": "IN"}[op], val)


# ---------------------------------------------------------------- tree definitions
@dataclass
class Spec:
    decision_type: str
    scope: str
    kind: str                                   # BEHAVIOR | OUTCOME | POLICY
    stage: str
    keep: Callable[[dict], bool] = lambda r: True
    label: Callable[[dict], str] = lambda r: r["option"]
    action_features: list[Feature] = field(default_factory=list)
    title: str = ""

    @property
    def tree_key(self) -> str:
        return f"tree:{self.decision_type}:{self.kind.lower()}:{self.scope.lower().replace(' ', '_')}"


def ai(version):
    return lambda r: r["actor_kind"] == "AI_AGENT" and r["version"] == version


def human(team=None):
    return lambda r: r["actor_kind"] == "HUMAN" and (team is None or r["team"] == team)


def has_outcome(t):
    return lambda r: t in r["outcome_types"]


logs_label = lambda r: "usage_logs" if "usage_logs" in r["options"] else "no_usage_logs"  # noqa: E731

SPECS = [
    Spec("charge.fraud_screen", "POLICY", "POLICY", "FINAL", title="Written fraud-screening policy"),
    Spec("charge.fraud_screen", "ALL", "BEHAVIOR", "FINAL", title="Fraud tool: actual screening"),
    Spec("support.complaint_resolution", "POLICY", "POLICY", "FINAL", title="Written refund policy"),
    Spec("support.complaint_resolution", "ALL", "BEHAVIOR", "FINAL", title="Complaints: final decisions"),
    Spec("support.complaint_resolution", "AI_AGENT:v1", "BEHAVIOR", "PROPOSAL", ai("v1"), title="AI v1 proposals"),
    Spec("support.complaint_resolution", "AI_AGENT:v2", "BEHAVIOR", "PROPOSAL", ai("v2"), title="AI v2 proposals"),
    Spec("support.complaint_resolution", "HUMAN", "BEHAVIOR", "FINAL", human(), title="Human decisions"),
    Spec("support.complaint_resolution", "HUMAN:Team A", "BEHAVIOR", "FINAL", human("Team A"), title="Team A decisions"),
    Spec("support.complaint_resolution", "HUMAN:Team B", "BEHAVIOR", "FINAL", human("Team B"), title="Team B decisions"),
    Spec("support.complaint_resolution", "ALL", "OUTCOME", "FINAL",
         label=lambda r: "dispute_filed" if "dispute_filed" in r["outcome_types"] else "no_dispute",
         action_features=[Feature("chosen.option", "categorical")], title="Complaints: what leads to disputes"),
    Spec("dispute.response", "POLICY", "POLICY", "FINAL", title="Written dispute policy"),
    Spec("dispute.response", "ALL", "BEHAVIOR", "FINAL", title="Disputes: accept or contest"),
    Spec("dispute.response", "AI_AGENT:v1", "BEHAVIOR", "FINAL", ai("v1"), title="AI v1 dispute responses"),
    Spec("dispute.response", "AI_AGENT:v2", "BEHAVIOR", "FINAL", ai("v2"), title="AI v2 dispute responses"),
    Spec("dispute.evidence", "ALL", "BEHAVIOR", "FINAL", label=logs_label, title="Evidence: usage logs included?"),
    Spec("dispute.evidence", "AI_AGENT:v1", "BEHAVIOR", "FINAL", ai("v1"), logs_label, title="AI v1 evidence"),
    Spec("dispute.evidence", "AI_AGENT:v2", "BEHAVIOR", "FINAL", ai("v2"), logs_label, title="AI v2 evidence"),
    Spec("dispute.evidence", "ALL", "OUTCOME", "FINAL", keep=lambda r: bool({"dispute_won", "dispute_lost"} & set(r["outcome_types"])),
         label=lambda r: "won" if "dispute_won" in r["outcome_types"] else "lost",
         action_features=[Feature(f"chosen.{e}", "boolean") for e in EVIDENCE_ITEMS], title="Evidence: what wins disputes"),
]

# ---------------------------------------------------------------- generic decision types (demo spec §23.8, phase C)
Q_GENERIC_TYPES = """
MATCH (t:DecisionType {status: 'APPROVED', created_by: 'mapping'})
MATCH (d:Decision {decision_type: t.key, scenario_id: $scenario, stage: 'FINAL'})
OPTIONAL MATCH (d)-[k:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
RETURN t.key AS type, count(DISTINCT d) AS n, count(DISTINCT o.option_key) AS options
"""


def polarity_label(r: dict) -> str:
    """Any domain: a decision's outcomes as good or bad for the organisation (from the mapping's polarity)."""
    pols = set(r.get("polarities") or [])
    return "bad" if "bad" in pols else "good" if "good" in pols else "no_outcome"


def generic_specs(driver: Driver, db: str, scenario: str) -> list[Spec]:
    """Trees for decision types a mapping introduced (e.g. loan.offer): how the choice depends on context (when there is
    more than one option) and what leads to good vs bad outcomes. Streamly's types keep their hand-written SPECS."""
    known = {sp.decision_type for sp in SPECS}
    out = []
    for r in driver.execute_query(Q_GENERIC_TYPES, scenario=scenario, database_=db).records:
        t, name = r["type"], r["type"].replace("_", " ")
        if t in known:
            continue
        several = r["options"] > 1
        if several:
            out.append(Spec(t, "ALL", "BEHAVIOR", "FINAL", title=f"{name}: how the choice is made"))
        out.append(Spec(t, "ALL", "OUTCOME", "FINAL", keep=lambda row: bool(row.get("polarities")), label=polarity_label,
                        action_features=[Feature("chosen.option", "categorical")] if several else [],
                        title=f"{name}: what leads to good outcomes"))
    return out


# ---------------------------------------------------------------- loading
Q_LOAD = """
MATCH (d:Decision {decision_type: $type, scenario_id: $scenario})
MATCH (d)-[:HAD_CONTEXT]->(c:Context)
MATCH (d)-[:MADE_BY]->(a:Actor)
OPTIONAL MATCH (d)-[k:CONSIDERED]->(o:Option) WHERE k.status IN ['CHOSEN', 'PROPOSED']
WITH d, c, a, collect(o.option_key) AS options
OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome)
RETURN d.decision_id AS id, d.stage AS stage, toString(d.decided_at) AS at, properties(c) AS ctx,
       a.kind AS actor_kind, a.version AS version, a.team AS team, options,
       collect(out.outcome_type) AS outcome_types, collect(out.polarity) AS polarities,
       sum(CASE WHEN out.outcome_type IN $cost THEN out.value_usd ELSE 0 END) AS cost
"""

Q_FEATURES = """
MATCH (s:SchemaElement {kind: 'ATTRIBUTE', status: 'APPROVED'})
RETURN s.key AS key, s.datatype AS datatype, s.encoding AS encoding, s.display_name AS display_name
"""

Q_OUTCOME_TYPES = "MATCH (s:SchemaElement {kind: 'OUTCOME_TYPE', status: 'APPROVED'}) RETURN s.key AS key"
Q_APPROVED_OPTIONS = "MATCH (s:SchemaElement {kind: 'OPTION', status: 'APPROVED'}) RETURN s.key AS key"


def load_decisions(driver: Driver, db: str, decision_type: str, scenario: str) -> list[dict]:
    rows = []
    for r in driver.execute_query(Q_LOAD, type=decision_type, scenario=scenario, cost=list(COST_OUTCOMES),
                                  database_=db).records:
        row = dict(r)
        row["option"] = row["options"][0] if row["options"] else None
        rows.append(row)
    return rows


# ---------------------------------------------------------------- building
@dataclass
class Built:
    tree: dict
    points: list = field(default_factory=list)
    branches: list = field(default_factory=list)
    fanouts: list = field(default_factory=list)
    at_point: list = field(default_factory=list)
    leaf_decisions: dict = field(default_factory=dict)   # point_id -> rows (for comparisons)


class Builder:
    def __init__(self, driver: Driver, db: str, scenario: str = "history"):
        self.driver, self.db, self.scenario = driver, db, scenario
        self.attrs = {r["key"]: dict(r) for r in driver.execute_query(Q_FEATURES, database_=db).records}
        self.outcome_types = sorted(r["key"].removeprefix("outcome.")
                                    for r in driver.execute_query(Q_OUTCOME_TYPES, database_=db).records)
        self.approved_options = {r["key"] for r in driver.execute_query(Q_APPROVED_OPTIONS, database_=db).records}
        self.built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def pid(self, value: str) -> str:
        return value if self.scenario == "history" else f"{self.scenario}|{value}"

    # ------------------------------------------------------------ features and labels
    def features(self, decision_type: str) -> list[Feature]:
        prefix = decision_type.split(".")[0] + "."
        out = []
        for key, a in sorted(self.attrs.items()):
            if not key.startswith(prefix):
                continue
            if a["datatype"] == "BOOLEAN":
                out.append(Feature(key, "boolean"))
            elif a["encoding"] == "NUMERIC":
                out.append(Feature(key, "numeric", integer=a["datatype"] == "INTEGER"))
            else:
                out.append(Feature(key, "categorical"))
        return out

    def display(self, attr: str) -> str:
        if attr == "chosen.option":
            return "Option chosen"
        if attr.startswith("chosen."):
            return f"{attr.removeprefix('chosen.').replace('_', ' ').capitalize()} included"
        return (self.attrs.get(attr) or {}).get("display_name") or attr

    def describe(self, cond: tuple) -> str:
        attr, op, val = cond
        name = self.display(attr)
        if isinstance(val, bool):
            yes = (op == "=") == val
            return f"{name}: {'yes' if yes else 'no'}"
        if isinstance(val, list):
            return f"{name} {'is' if op == 'IN' else 'is not'} {', '.join(str(v).replace('_', ' ') for v in val)}"
        shown = f"${val:,.0f}" if attr.endswith("_usd") else f"{val}"
        return f"{name} {op.replace('>=', '≥').replace('<=', '≤')} {shown}"

    def admissible(self, decision_type: str, option: str | None) -> bool:
        """Options still PROPOSED in the schema registry stay out of trees until approved."""
        return option is None or f"{decision_type}.{option}" in self.approved_options

    # ------------------------------------------------------------ stats
    def stats(self, rows: list[dict]) -> dict:
        n = len(rows)
        s = {"support": n}
        for t in self.outcome_types:
            s[f"rate_{t}"] = round(sum(1 for r in rows if t in r["outcome_types"]) / n, 4) if n else None
        s["cost_per_decision"] = round(sum(r["cost"] for r in rows) / n, 2) if n else None
        return s

    def fanout(self, point_id: str, spec: Spec, rows: list[dict]) -> list[dict]:
        out = []
        groups = defaultdict(list)
        for r in rows:
            groups[spec.label(r)].append(r)
        for label, grp in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            if spec.decision_type == "dispute.evidence":
                option, included = "usage_logs", label == "usage_logs"
            else:
                option, included = label, None
            out.append({"from": point_id, "decision_type": spec.decision_type, "option_key": option,
                        "included": included, "label": label.replace("_", " "),
                        "props": {"share": round(len(grp) / len(rows), 4), **self.stats(grp),
                                  "label": label.replace("_", " "), "included": included}})
        return out

    # ------------------------------------------------------------ one tree
    def build(self, spec: Spec, all_rows: list[dict]) -> Built | None:
        rows = [r for r in all_rows if r["stage"] == spec.stage and spec.keep(r)
                and self.admissible(spec.decision_type, r["option"])]
        if len(rows) < 100:
            return None
        for r in rows:
            r["x"] = dict(r["ctx"])
            r["x"]["chosen.option"] = r["option"]
            for e in EVIDENCE_ITEMS:
                r["x"][f"chosen.{e}"] = e in r["options"]
        tree_id = self.pid(spec.tree_key)
        dates = sorted(r["at"] for r in rows)
        built = Built({"tree_id": tree_id, "decision_type": spec.decision_type, "scope": spec.scope, "kind": spec.kind,
                       "stage": spec.stage, "title": spec.title, "built_at": self.built_at, "window_start": dates[0],
                       "window_end": dates[-1], "schema_version": 1, "algorithm_version": ALGORITHM_VERSION,
                       "n_decisions": len(rows), "scenario_id": self.scenario, "policy_id": None, "policy_version": None,
                       "policy_text": None})
        if spec.kind == "POLICY":
            p = POLICY_TREES[spec.decision_type]
            built.tree.update(policy_id=p["policy"][0], policy_version=p["policy"][1], policy_text=p["text"])
            self._policy(built, spec, p["tree"], rows, "r", 0, [], len(rows))
        else:
            # Outcome labels are rare events (e.g. ~8% disputes), so impurity gains are small: lower the bar
            learner = TreeLearner(min_leaf=max(50, round(0.01 * len(rows))),
                                  min_gain=0.0005 if spec.kind == "OUTCOME" else 0.002,
                                  features=self.features(spec.decision_type) + spec.action_features)
            root = learner.fit([r["x"] for r in rows], [spec.label(r) for r in rows])
            self._learned(built, spec, root, rows, [], len(rows))
        return built

    def _point(self, built: Built, spec: Spec, path: str, depth: int, rows: list[dict], conds: list, n_root: int,
               is_leaf: bool, discovered_by: str, extra: dict) -> str:
        point_id = f"{built.tree['tree_id']}/{path}"
        labels = Counter(spec.label(r) for r in rows)
        top, top_n = labels.most_common(1)[0] if labels else (None, 0)
        props = {"decision_type": spec.decision_type, "tree_id": built.tree["tree_id"], "discovered_by": discovered_by,
                 "algorithm_version": ALGORITHM_VERSION if discovered_by == "TREE_LEARNER" else None,
                 "depth": depth, "is_leaf": is_leaf, "share": round(len(rows) / n_root, 4) if n_root else 0,
                 "path_label": " and ".join(self.describe(c) for c in conds) or "All decisions",
                 "top_label": top, "top_share": round(top_n / len(rows), 4) if rows else None,
                 "labels": [k for k, _ in labels.most_common()], "label_counts": [v for _, v in labels.most_common()],
                 "scenario_id": self.scenario, **self.stats(rows), **extra}
        built.points.append({"point_id": point_id, "props": props})
        if is_leaf:
            built.leaf_decisions[point_id] = rows
            built.at_point.extend({"decision_id": r["id"], "point_id": point_id} for r in rows)
            if spec.kind != "OUTCOME":
                built.fanouts.extend(self.fanout(point_id, spec, rows))
        return point_id

    def _edge(self, built: Built, parent: str, child: str, cond: tuple, rows: list[dict], parent_n: int) -> None:
        attr, op, val = cond
        built.branches.append({"from": parent, "to": child, "props": {
            "attribute": attr, "operator": op, "value": val, "label": self.describe(cond),
            "support": len(rows), "share": round(len(rows) / parent_n, 4) if parent_n else 0}})

    def _learned(self, built: Built, spec: Spec, node: Node, rows: list[dict], conds: list, n_root: int) -> str:
        mine = [rows[i] for i in node.indices] if not conds else rows
        pid = self._point(built, spec, node.path, node.depth, mine, conds, n_root, node.is_leaf, "TREE_LEARNER", {})
        if not node.is_leaf:
            lc, rc = node.split.conditions()
            left_rows = [r for r in mine if node.split.goes_left(r["x"])]
            right_rows = [r for r in mine if not node.split.goes_left(r["x"])]
            lid = self._learned(built, spec, node.left, left_rows, conds + [lc], n_root)
            rid = self._learned(built, spec, node.right, right_rows, conds + [rc], n_root)
            self._edge(built, pid, lid, lc, left_rows, len(mine))
            self._edge(built, pid, rid, rc, right_rows, len(mine))
        return pid

    def _policy(self, built: Built, spec: Spec, node: dict, rows: list[dict], path: str, depth: int, conds: list,
                n_root: int) -> str:
        if "option" in node:
            follows = sum(1 for r in rows if r["option"] == node["option"])
            return self._point(built, spec, path, depth, rows, conds, n_root, True, "POLICY",
                               {"policy_option": node["option"],
                                "policy_compliance": round(follows / len(rows), 4) if rows else None})
        cond = node["split"]
        pid = self._point(built, spec, path, depth, rows, conds, n_root, False, "POLICY", {})
        left_rows = [r for r in rows if holds(r["x"], cond)]
        right_rows = [r for r in rows if not holds(r["x"], cond)]
        lid = self._policy(built, spec, node["left"], left_rows, path + ".L", depth + 1, conds + [cond], n_root)
        rid = self._policy(built, spec, node["right"], right_rows, path + ".R", depth + 1, conds + [negate(cond)], n_root)
        self._edge(built, pid, lid, cond, left_rows, len(rows))
        self._edge(built, pid, rid, negate(cond), right_rows, len(rows))
        return pid


# ---------------------------------------------------------------- comparisons
def tvd(a: list[dict], b: list[dict], label: Callable[[dict], str]) -> float:
    ca, cb = Counter(label(r) for r in a), Counter(label(r) for r in b)
    na, nb = sum(ca.values()), sum(cb.values())
    return round(0.5 * sum(abs(ca[k] / na - cb[k] / nb) for k in set(ca) | set(cb)), 4) if na and nb else 0.0


def comparisons(built: dict[str, Built], rows_by_type: dict[str, list[dict]], pid: Callable[[str], str],
                override_rate: float | None) -> list[dict]:
    out = []

    def add(a_key, b_key, metric, value, note):
        a, b = built.get(pid(a_key)), built.get(pid(b_key))
        if a and b:
            out.append({"from": a.tree["tree_id"], "to": b.tree["tree_id"], "metric": metric, "divergence": value,
                        "note": note})

    for spec in SPECS:
        if spec.kind != "POLICY":
            continue
        tree = built.get(pid(spec.tree_key))
        if not tree:
            continue
        leaves = [p for p in tree.points if p["props"]["is_leaf"]]
        n = sum(p["props"]["support"] for p in leaves)
        follow = sum(p["props"]["support"] * p["props"]["policy_compliance"] for p in leaves)
        add(spec.tree_key, f"tree:{spec.decision_type}:behavior:all", "policy_divergence", round(1 - follow / n, 4),
            "Share of decisions that differ from what the written policy prescribes")

    def scope_rows(decision_type, stage, keep):
        return [r for r in rows_by_type[decision_type] if r["stage"] == stage and keep(r)]

    for t, stage in (("support.complaint_resolution", "PROPOSAL"), ("dispute.response", "FINAL"), ("dispute.evidence", "FINAL")):
        label = logs_label if t == "dispute.evidence" else (lambda r: r["option"])
        add(f"tree:{t}:behavior:ai_agent:v1", f"tree:{t}:behavior:ai_agent:v2", "option_tvd",
            tvd(scope_rows(t, stage, ai("v1")), scope_rows(t, stage, ai("v2")), label),
            "Total variation distance between option distributions")
    t = "support.complaint_resolution"
    add(f"tree:{t}:behavior:human:team_a", f"tree:{t}:behavior:human:team_b", "option_tvd",
        tvd(scope_rows(t, "FINAL", human("Team A")), scope_rows(t, "FINAL", human("Team B")), lambda r: r["option"]),
        "Total variation distance between option distributions")
    if override_rate is not None:
        add(f"tree:{t}:behavior:ai_agent:v2", f"tree:{t}:behavior:human", "override_rate", override_rate,
            "Share of human final decisions that override the AI proposal (all AI versions)")
    return out


# ---------------------------------------------------------------- writing
Q_DELETE_TREE = """
MATCH (t:DecisionTree {tree_id: $tree_id})
OPTIONAL MATCH (p:DecisionPoint {tree_id: $tree_id})
DETACH DELETE t, p
"""
Q_TREE = """
CREATE (t:DecisionTree) SET t = $tree, t.built_at = datetime($tree.built_at),
       t.window_start = datetime($tree.window_start), t.window_end = datetime($tree.window_end)
WITH t
OPTIONAL MATCH (p:Policy {policy_id: $tree.policy_id, version: $tree.policy_version})
FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | MERGE (p)-[:DEFINES]->(t))
"""
Q_POINTS = """
UNWIND $rows AS r
CREATE (p:DecisionPoint {point_id: r.point_id}) SET p += r.props
"""
Q_ROOT = "MATCH (t:DecisionTree {tree_id: $tree_id}), (p:DecisionPoint {point_id: $root}) MERGE (t)-[:ROOT]->(p)"
Q_BRANCHES = """
UNWIND $rows AS r
MATCH (a:DecisionPoint {point_id: r.from}), (b:DecisionPoint {point_id: r.to})
CREATE (a)-[br:BRANCH]->(b) SET br += r.props
"""
Q_FANOUTS = """
UNWIND $rows AS r
MATCH (a:DecisionPoint {point_id: r.from}), (o:Option {decision_type: r.decision_type, option_key: r.option_key})
CREATE (a)-[br:BRANCH]->(o) SET br += r.props, br.leaf = true
"""
Q_AT_POINT = """
UNWIND $rows AS r
MATCH (d:Decision {decision_id: r.decision_id}), (p:DecisionPoint {point_id: r.point_id})
MERGE (d)-[a:AT_POINT]->(p) SET a.assigned_by = $by, a.confidence = 1.0
"""
Q_COMPARE = """
UNWIND $rows AS r
MATCH (a:DecisionTree {tree_id: r.from}), (b:DecisionTree {tree_id: r.to})
MERGE (a)-[c:COMPARED_TO {metric: r.metric}]->(b)
SET c.divergence = r.divergence, c.note = r.note, c.computed_at = datetime()
"""
Q_OVERRIDE_RATE = """
MATCH (f:Decision {decision_type: 'support.complaint_resolution', stage: 'FINAL', scenario_id: $scenario})
      -[:MADE_BY]->(:Actor {kind: 'HUMAN'})
WITH f, EXISTS { (f)-[:OVERRIDES]->() } AS overridden
RETURN CASE count(f) WHEN 0 THEN null ELSE toFloat(sum(CASE WHEN overridden THEN 1 ELSE 0 END)) / count(f) END AS rate
"""   # null when the scenario has no human complaint decisions (another domain)


def write_tree(driver: Driver, db: str, b: Built) -> None:
    tid = b.tree["tree_id"]
    driver.execute_query(Q_DELETE_TREE, tree_id=tid, database_=db)
    driver.execute_query(Q_TREE, tree=b.tree, database_=db)
    driver.execute_query(Q_POINTS, rows=b.points, database_=db)
    driver.execute_query(Q_ROOT, tree_id=tid, root=f"{tid}/r", database_=db)
    driver.execute_query(Q_BRANCHES, rows=b.branches, database_=db)
    driver.execute_query(Q_FANOUTS, rows=b.fanouts, database_=db)
    by = "POLICY" if b.tree["kind"] == "POLICY" else "TREE_LEARNER"
    for i in range(0, len(b.at_point), 5000):
        driver.execute_query(Q_AT_POINT, rows=b.at_point[i:i + 5000], by=by, database_=db)


def build_all(driver: Driver, db: str, scenario: str = "history", log: Callable[[str], None] = print) -> dict[str, Built]:
    builder = Builder(driver, db, scenario)
    specs = SPECS + generic_specs(driver, db, scenario)
    rows_by_type = {t: load_decisions(driver, db, t, scenario) for t in {s.decision_type for s in specs}}
    built: dict[str, Built] = {}
    for spec in specs:
        b = builder.build(spec, rows_by_type[spec.decision_type])
        if not b:
            log(f"  skipped {spec.tree_key} (too few decisions)")
            continue
        write_tree(driver, db, b)
        built[b.tree["tree_id"]] = b
        leaves = sum(1 for p in b.points if p["props"]["is_leaf"])
        log(f"  {spec.tree_key:<58} n={b.tree['n_decisions']:>6}  leaves={leaves}")
    rate = driver.execute_query(Q_OVERRIDE_RATE, scenario=scenario, database_=db).records[0]["rate"]
    comps = comparisons(built, rows_by_type, builder.pid, rate)
    driver.execute_query(Q_COMPARE, rows=comps, database_=db)
    for c in comps:
        log(f"  compared {c['from'].split(':', 1)[1]} -> {c['to'].split(':', 1)[1]}: {c['metric']} = {c['divergence']}")
    return built
