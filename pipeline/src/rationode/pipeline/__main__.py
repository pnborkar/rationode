"""Rationode pipeline CLI.

    uv run python -m rationode.pipeline ingest history_events.jsonl [--scenario history]
    uv run python -m rationode.pipeline reset --scenario history
    uv run python -m rationode.pipeline stats
    uv run python -m rationode.pipeline dana
"""

import argparse
import json
import time
from pathlib import Path

from rationode.db import REPO_ROOT, database, driver
from rationode.pipeline.detect import Detector
from rationode.pipeline.write import load_registry, write

GENERATED = REPO_ROOT / "data" / "generated"
SCENARIO_LABELS = ["DecisionPoint", "DecisionTree", "Event", "Decision", "Context", "Entity", "Outcome", "Actor"]


def ingest(path: str, scenario: str) -> None:
    file = Path(path) if Path(path).exists() else GENERATED / path
    raw = [json.loads(line) for line in file.open()]
    with driver() as d:
        db = database()
        start = time.time()
        detector = Detector(load_registry(d, db), scenario)
        rows = detector.run(raw)
        print(f"Detected from {len(raw)} events in {time.time() - start:.1f}s: "
              f"{len(rows.decisions)} decisions, {len(rows.outcomes)} outcomes, {len(rows.overrides)} overrides, "
              f"{len(rows.schema_proposals)} schema proposals, {len(rows.review)} to review")
        if rows.review:
            review_file = GENERATED / f"review_queue_{scenario}.jsonl"
            review_file.write_text("".join(json.dumps(r) + "\n" for r in rows.review))
            print(f"Review queue written to {review_file}")
        write(d, db, rows)
        print(f"Done in {time.time() - start:.1f}s")


def reset(scenario: str) -> None:
    with driver() as d, d.session(database=database()) as s:
        for label in SCENARIO_LABELS:
            result = s.run(f"MATCH (n:{label}) WHERE n.scenario_id = $scenario "
                           "CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS", scenario=scenario)
            print(f"  {label:<9} deleted {result.consume().counters.nodes_deleted}")
        if scenario == "history":
            # Detector-proposed schema elements return to "not yet seen" so they are proposed again
            result = s.run("MATCH (e:SchemaElement {created_by: 'detector'}) "
                           "OPTIONAL MATCH (c:SchemaChange)-[:AFFECTS]->(e) "
                           "OPTIONAL MATCH (o:Option {decision_type: e.decision_type}) "
                           "WHERE e.key = e.decision_type + '.' + o.option_key "
                           "DETACH DELETE e, c, o")
            print(f"  proposed schema elements deleted {result.consume().counters.nodes_deleted}")


def stats() -> None:
    with driver() as d:
        db = database()
        nodes = d.execute_query("CALL db.labels() YIELD label CALL (label) { MATCH (n) WHERE label IN labels(n) "
                                "RETURN count(n) AS n } RETURN label, n ORDER BY label", database_=db).records
        rels = d.execute_query("CALL db.relationshipTypes() YIELD relationshipType AS t CALL (t) { MATCH ()-[r]->() "
                               "WHERE type(r) = t RETURN count(r) AS n } RETURN t, n ORDER BY t", database_=db).records
    print("Nodes:")
    for r in nodes:
        print(f"  {r['label']:<16} {r['n']:>8}")
    print("Relationships:")
    for r in rels:
        print(f"  {r['t']:<16} {r['n']:>8}")


DANA_PATH = """
MATCH (c:Customer:Entity {source_system: 'stripe'}) WHERE c.name = 'Dana Whitfield'
MATCH (d:Decision)-[:ABOUT]->(c)
MATCH (d)-[:MADE_BY]->(a:Actor)
OPTIONAL MATCH (d)-[k:CONSIDERED]->(o:Option) WHERE k.status IN ['CHOSEN', 'PROPOSED']
OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome)
WITH d, a, collect(DISTINCT o.option_key) AS options,
     collect(DISTINCT out.outcome_type + CASE WHEN out.value_usd IS NULL THEN '' ELSE ' $' + toString(out.value_usd) END) AS outcomes
RETURN d.decided_at AS at, d.decision_type AS type, d.stage AS stage, a.kind + ' ' + coalesce(a.name, '') AS actor,
       options, outcomes, EXISTS { (d)-[:OVERRIDES]->() } AS overrides
ORDER BY at
"""


def dana() -> None:
    with driver() as d:
        records = d.execute_query(DANA_PATH, database_=database()).records
    for r in records:
        print(f"{str(r['at'])[:16]}  {r['type']:<30} {r['stage']:<8} {r['actor']:<34} "
              f"{', '.join(r['options']):<28} -> {', '.join(r['outcomes']) or '—'}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="rationode.pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("ingest")
    p.add_argument("file")
    p.add_argument("--scenario", default="history")
    p = sub.add_parser("reset")
    p.add_argument("--scenario", required=True)
    sub.add_parser("stats")
    sub.add_parser("dana")
    args = parser.parse_args()
    if args.cmd == "ingest":
        ingest(args.file, args.scenario)
    elif args.cmd == "reset":
        reset(args.scenario)
    elif args.cmd == "stats":
        stats()
    else:
        dana()


if __name__ == "__main__":
    main()
