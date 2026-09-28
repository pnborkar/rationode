"""check_before_act: what happened in similar past decisions, before an agent acts.

1. Vector search on the case's context text (context_embedding_v1) for candidates
   of the same decision type.
2. Expand with GDS kNN neighbours (SIMILAR_TO) of the best candidates, when present.
3. Re-rank by combined text and feature similarity; keep the top k.
4. Summarize: options chosen in those cases and their outcomes; plus the branch
   the case falls into in the learned outcome and behavior trees.
"""

import math
from collections import defaultdict

from neo4j import Driver

from rationode.analytics.embed import embed_texts
from rationode.analytics.features import Encoder, context_text
from rationode.trees.build import COST_OUTCOMES, holds

Q_CANDIDATES = """
CALL db.index.vector.queryNodes('context_embedding_v1', $pool, $vector) YIELD node AS c, score
MATCH (d:Decision {decision_type: $type, stage: 'FINAL', scenario_id: $scenario})-[:HAD_CONTEXT]->(c)
RETURN d.decision_id AS id, score, properties(c) AS ctx
"""

Q_NEIGHBOURS = """
UNWIND $ids AS id
MATCH (:Decision {decision_id: id})-[:SIMILAR_TO]->(n:Decision)-[:HAD_CONTEXT]->(c:Context)
RETURN DISTINCT n.decision_id AS id, properties(c) AS ctx
"""

Q_DETAILS = """
UNWIND $ids AS id
MATCH (d:Decision {decision_id: id})-[:MADE_BY]->(a:Actor)
OPTIONAL MATCH (d)-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
WITH d, a, collect(o.option_key) AS options
OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome)
RETURN d.decision_id AS id, a.kind AS actor_kind, a.version AS version, options,
       collect(out.outcome_type) AS outcomes,
       sum(CASE WHEN out.outcome_type IN $cost THEN out.value_usd ELSE 0 END) AS cost
"""

Q_TREE = """
MATCH (t:DecisionTree {decision_type: $type, kind: $kind, scope: 'ALL', scenario_id: $scenario})-[:ROOT]->(root)
MATCH (p:DecisionPoint {tree_id: t.tree_id})
OPTIONAL MATCH (p)-[b:BRANCH]->(child:DecisionPoint)
RETURN t.tree_id AS tree_id, root.point_id AS root, p.point_id AS id, p.is_leaf AS leaf, p.path_label AS path_label,
       p.support AS support, p.rate_dispute_filed AS dispute_rate, p.rate_dispute_won AS win_rate,
       p.rate_churn AS churn_rate, p.cost_per_decision AS cost,
       collect(CASE WHEN child IS NULL THEN null ELSE {to: child.point_id, attribute: b.attribute,
               operator: b.operator, value: b.value} END) AS branches
"""


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def route(driver: Driver, db: str, decision_type: str, kind: str, x: dict, scenario: str) -> dict | None:
    rows = driver.execute_query(Q_TREE, type=decision_type, kind=kind, scenario=scenario, database_=db).records
    if not rows:
        return None
    points = {r["id"]: dict(r) for r in rows}
    node = points[rows[0]["root"]]
    while not node["leaf"]:
        nxt = next((b["to"] for b in node["branches"] if b and holds(x, (b["attribute"], b["operator"], b["value"]))), None)
        if nxt is None:
            break
        node = points[nxt]
    return {"tree_id": rows[0]["tree_id"], "point_id": node["id"], "branch": node["path_label"],
            "support": node["support"], "dispute_rate": node["dispute_rate"], "win_rate": node["win_rate"],
            "churn_rate": node["churn_rate"], "cost_per_decision": node["cost"]}


WHAT_IF_ACTIONS = {
    "support.complaint_resolution": [{"chosen.option": o} for o in ("full_refund", "partial_refund", "voucher", "deny")],
    "dispute.evidence": [{"chosen.usage_logs": True, "chosen.tos_acceptance": True},
                         {"chosen.usage_logs": False, "chosen.tos_acceptance": True}],
}


def what_if(driver: Driver, db: str, decision_type: str, context: dict, scenario: str) -> list[dict]:
    """Route the case through the OUTCOME tree once per possible action."""
    out = []
    for action in WHAT_IF_ACTIONS.get(decision_type, []):
        leaf = route(driver, db, decision_type, "OUTCOME", {**context, **action}, scenario)
        if leaf:
            name = action.get("chosen.option") or ("with usage logs" if action.get("chosen.usage_logs") else "without usage logs")
            out.append({"action": name, **leaf})
    return out


def check_before_act(driver: Driver, db: str, decision_type: str, context: dict, k: int = 150,
                     scenario: str = "history", pool: int = 1500) -> dict:
    encoder = Encoder(driver, db)
    text = context_text(decision_type, context)
    vector = embed_texts([text])[0]
    features = encoder.vector(decision_type, context)

    cands = {r["id"]: {"text_score": r["score"], "ctx": r["ctx"]}
             for r in driver.execute_query(Q_CANDIDATES, pool=pool, vector=vector, type=decision_type,
                                           scenario=scenario, database_=db).records}
    for c in cands.values():
        c["feature_score"] = cosine(features, encoder.vector(decision_type, c["ctx"]))
    seeds = sorted(cands, key=lambda i: -cands[i]["feature_score"])[:10]
    via_knn = 0
    for r in driver.execute_query(Q_NEIGHBOURS, ids=seeds, database_=db).records:
        if r["id"] not in cands:
            via_knn += 1
            cands[r["id"]] = {"text_score": None, "ctx": r["ctx"],
                              "feature_score": cosine(features, encoder.vector(decision_type, r["ctx"]))}
    for c in cands.values():
        text_score = c["text_score"] if c["text_score"] is not None else 0.9
        c["score"] = 0.3 * text_score + 0.7 * c["feature_score"]
    top = sorted(cands, key=lambda i: -cands[i]["score"])[:k]

    details = {r["id"]: dict(r) for r in driver.execute_query(Q_DETAILS, ids=top, cost=list(COST_OUTCOMES),
                                                               database_=db).records}
    by_option: dict[str, list[dict]] = defaultdict(list)
    for i in top:
        d = details[i]
        label = ("usage_logs" if "usage_logs" in d["options"] else "no_usage_logs") \
            if decision_type == "dispute.evidence" else (d["options"][0] if d["options"] else "unknown")
        by_option[label].append(d)

    def rate(rows, t):
        return round(sum(1 for r in rows if t in r["outcomes"]) / len(rows), 3)

    options = []
    for label, rows in sorted(by_option.items(), key=lambda kv: -len(kv[1])):
        options.append({"option": label, "n": len(rows), "share": round(len(rows) / len(top), 3),
                        "dispute_rate": rate(rows, "dispute_filed"), "churn_rate": rate(rows, "churn"),
                        "win_rate": rate(rows, "dispute_won"),
                        "avg_cost": round(sum(r["cost"] for r in rows) / len(rows), 2)})

    x = dict(context)
    return {
        "decision_type": decision_type, "case": text, "similar_decisions": len(top),
        "candidates": {"vector": len(cands) - via_knn, "knn_expansion": via_knn},
        "options": options,
        "examples": [{"decision_id": i, "score": round(cands[i]["score"], 3),
                      "context": context_text(decision_type, cands[i]["ctx"])} for i in top[:3]],
        "what_if": what_if(driver, db, decision_type, x, scenario),
        "behavior_branch": route(driver, db, decision_type, "BEHAVIOR", x, scenario),
    }
