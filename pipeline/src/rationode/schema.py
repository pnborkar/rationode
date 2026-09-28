"""Apply the core schema and seed the registry.

Usage:
    uv run python -m rationode.schema check    # connectivity only
    uv run python -m rationode.schema apply    # constraints, indexes, registry
    uv run python -m rationode.schema status   # what exists
"""

import sys
from pathlib import Path

from rationode import registry
from rationode.db import database, driver

CYPHER_DIR = Path(__file__).resolve().parents[2] / "cypher"

SEED_ELEMENTS = """
UNWIND $rows AS row
MERGE (s:SchemaElement {key: row.key})
ON CREATE SET s.created_at = datetime(), s.created_by = 'seed', s.version = 1,
              s.status = 'APPROVED', s.aliases = []
SET s.kind = row.kind, s.datatype = row.datatype, s.encoding = row.encoding,
    s.values = row.values, s.default_window_days = row.window_days,
    s.decision_type = row.decision_type, s.display_name = row.display_name
"""

SEED_TYPES_AND_OPTIONS = """
UNWIND $types AS t
MERGE (dt:DecisionType {key: t.key})
ON CREATE SET dt.version = 1, dt.status = 'APPROVED'
SET dt.display_name = t.display_name
WITH t
UNWIND t.options AS opt
MERGE (:Option {decision_type: t.key, option_key: opt})
"""


def statements() -> list[str]:
    text = (CYPHER_DIR / "schema.cypher").read_text()
    lines = [ln for ln in text.splitlines() if not ln.strip().startswith("//")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


def check() -> None:
    with driver() as d:
        d.verify_connectivity()
        info = d.execute_query(
            "CALL dbms.components() YIELD name, versions, edition RETURN name, versions[0] AS version, edition",
            database_=database(),
        ).records[0]
        print(f"Connected: {info['name']} {info['version']} ({info['edition']})")


def apply() -> None:
    with driver() as d:
        for stmt in statements():
            d.execute_query(stmt, database_=database())
        print(f"Applied {len(statements())} schema statements")

        rows = registry.elements()
        d.execute_query(SEED_ELEMENTS, rows=rows, database_=database())
        types = [{"key": k, "display_name": v["display_name"], "options": v["options"]}
                 for k, v in registry.DECISION_TYPES.items()]
        d.execute_query(SEED_TYPES_AND_OPTIONS, types=types, database_=database())
        print(f"Seeded {len(rows)} schema elements, {len(types)} decision types")


def status() -> None:
    with driver() as d:
        db = database()
        constraints = d.execute_query("SHOW CONSTRAINTS YIELD name RETURN count(*) AS n", database_=db).records[0]["n"]
        indexes = d.execute_query(
            "SHOW INDEXES YIELD name, type, state RETURN type, state, count(*) AS n ORDER BY type", database_=db
        ).records
        elements = d.execute_query(
            "MATCH (s:SchemaElement) RETURN s.kind AS kind, s.status AS status, count(*) AS n ORDER BY kind",
            database_=db,
        ).records
        options = d.execute_query(
            "MATCH (o:Option) "
            "RETURN o.decision_type AS type, collect(o.option_key) AS options ORDER BY type",
            database_=db,
        ).records
    print(f"Constraints: {constraints}")
    for r in indexes:
        print(f"Indexes: {r['type']:<8} {r['state']:<8} {r['n']}")
    for r in elements:
        print(f"SchemaElement: {r['kind']:<15} {r['status']:<9} {r['n']}")
    for r in options:
        print(f"{r['type']}: {', '.join(sorted(r['options']))}")


if __name__ == "__main__":
    commands = {"check": check, "apply": apply, "status": status}
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd not in commands:
        sys.exit(f"Unknown command {cmd!r}; use one of {', '.join(commands)}")
    commands[cmd]()
