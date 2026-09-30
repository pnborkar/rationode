"""Decision trees CLI.

    uv run python -m rationode.trees build [--scenario history]
    uv run python -m rationode.trees list
    uv run python -m rationode.trees show <tree_id>
    uv run python -m rationode.trees reveals
"""

import argparse
import time

from rationode.db import database, driver
from rationode.trees.build import build_all
from rationode.trees.reveals import REVEALS

Q_LIST = """
MATCH (t:DecisionTree {scenario_id: $scenario})
RETURN t.tree_id AS tree_id, t.kind AS kind, t.n_decisions AS n, t.title AS title,
       count{ (:DecisionPoint {tree_id: t.tree_id, is_leaf: true}) } AS leaves
ORDER BY tree_id
"""

Q_SHOW = """
MATCH (t:DecisionTree {tree_id: $tree_id})
MATCH (p:DecisionPoint {tree_id: $tree_id})
OPTIONAL MATCH (parent:DecisionPoint)-[b:BRANCH]->(p)
OPTIONAL MATCH (p)-[f:BRANCH]->(o:Option)
WITH t, p, b, collect(f {.label, .share, .support, .cost_per_decision, .rate_dispute_filed, .rate_dispute_won, .rate_churn,
                          option: o.option_key}) AS fan
RETURN t.title AS title, t.policy_text AS policy_text, t.decision_type AS decision_type, properties(p) AS props,
       p.point_id AS id, p.depth AS depth, p.is_leaf AS leaf,
       b.label AS condition, p.support AS support, p.top_label AS top, p.top_share AS top_share,
       p.policy_option AS policy_option, p.rate_dispute_filed AS dispute, p.rate_dispute_won AS won,
       p.rate_churn AS churn, p.cost_per_decision AS cost, fan
ORDER BY id
"""


def pct(v) -> str:
    return "  —  " if v is None else f"{100 * v:4.0f}%"


def show(tree_id: str) -> None:
    with driver() as d:
        rows = d.execute_query(Q_SHOW, tree_id=tree_id, database_=database()).records
    if not rows:
        print("No such tree")
        return
    print(rows[0]["title"])
    if rows[0]["policy_text"]:
        print(f"Policy: {rows[0]['policy_text']}")
    streamly = rows[0]["decision_type"] in {"charge.fraud_screen", "support.complaint_resolution", "dispute.response", "dispute.evidence"}
    for r in rows:
        indent = "    " * r["depth"]
        cond = r["condition"] or "ALL"
        line = f"{indent}{cond}  (n={r['support']})"
        if not streamly:   # any domain (§23.8): the most likely label here and the outcome rates this point has
            rates = sorted(((k.removeprefix("rate_"), v) for k, v in r["props"].items() if k.startswith("rate_") and v), key=lambda kv: -kv[1])
            line += f"  mostly {r['top'] or '—'} ({pct(r['top_share']).strip()})  " + " · ".join(f"{t.replace('_', ' ')} {pct(v).strip()}" for t, v in rates)
            print(line)
            continue
        if r["leaf"]:
            if r["policy_option"]:
                line += f"  policy says: {r['policy_option']}"
            line += f"  dispute {pct(r['dispute'])} won {pct(r['won'])} churn {pct(r['churn'])} cost/dec ${r['cost'] or 0:.2f}"
        print(line)
        for f in sorted(r["fan"], key=lambda x: -(x["share"] or 0)):
            if f["option"] is None:
                continue
            print(f"{indent}    → {f['label']:<16} {pct(f['share'])} (n={f['support']})  dispute {pct(f['rate_dispute_filed'])}"
                  f" won {pct(f['rate_dispute_won'])} churn {pct(f['rate_churn'])} cost/dec ${f['cost_per_decision'] or 0:.2f}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="rationode.trees")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("build")
    p.add_argument("--scenario", default="history")
    p = sub.add_parser("list")
    p.add_argument("--scenario", default="history")
    p = sub.add_parser("show")
    p.add_argument("tree_id")
    p = sub.add_parser("reveals")
    p.add_argument("--scenario", default="history")
    args = parser.parse_args()

    with driver() as d:
        db = database()
        if args.cmd == "build":
            start = time.time()
            build_all(d, db, args.scenario)
            print(f"Built in {time.time() - start:.1f}s")
        elif args.cmd == "list":
            for r in d.execute_query(Q_LIST, scenario=args.scenario, database_=db).records:
                print(f"{r['tree_id']:<60} {r['kind']:<9} n={r['n']:>6} leaves={r['leaves']:>2}  {r['title']}")
        elif args.cmd == "reveals":
            for reveal in REVEALS.values():
                print(f"\n{reveal['title']}")
                for r in d.execute_query(reveal["cypher"], scenario=args.scenario, database_=db).records:
                    print("  " + "  ".join(f"{k}={v}" for k, v in dict(r).items()))
    if args.cmd == "show":
        show(args.tree_id)


if __name__ == "__main__":
    main()
