"""Write detector rows to Neo4j with batched, idempotent MERGEs."""

import time
from collections.abc import Callable

from neo4j import Driver

from rationode.pipeline.detect import POLICIES, Registry, Rows

BATCH = 5000

Q_EVENTS = """
UNWIND $rows AS r
MERGE (e:Event {event_id: r.event_id})
SET e.source_system = r.source_system, e.event_type = r.event_type, e.occurred_at = datetime(r.occurred_at),
    e.payload_json = r.payload_json, e.payload_ref = 'inline:payload_json',
    e.charge_id = r.charge_id, e.ticket_id = r.ticket_id, e.dispute_id = r.dispute_id,
    e.stripe_customer_id = r.stripe_customer_id, e.email = r.email, e.scenario_id = r.scenario_id
"""

Q_ENTITIES = """
UNWIND $rows AS r
MERGE (e:Entity {entity_id: r.entity_id})
SET e:{label}, e.source_system = r.source_system, e.source_key = r.source_key, e.scenario_id = r.scenario_id
SET e += r.props
"""

Q_SAME_AS = """
UNWIND $rows AS r
MATCH (a:Entity {entity_id: r.from}), (b:Entity {entity_id: r.to})
MERGE (a)-[s:SAME_AS]->(b)
SET s.confidence = r.confidence, s.method = r.method
"""

Q_ACTORS = """
UNWIND $rows AS r
MERGE (a:Actor {actor_id: r.actor_id})
SET a.kind = r.kind, a.version = r.version, a.name = r.name, a.team = r.team, a.scenario_id = r.scenario_id
"""

Q_POLICIES = """
UNWIND $rows AS r
MERGE (p:Policy {policy_id: r.policy_id, version: r.version})
ON CREATE SET p.valid_from = date('2025-01-01'), p.valid_to = null
"""

Q_PROPOSALS = """
UNWIND $rows AS r
MERGE (s:SchemaElement {key: r.key})
ON CREATE SET s.kind = 'OPTION', s.status = 'PROPOSED', s.decision_type = r.decision_type, s.version = 1,
              s.created_at = datetime(), s.created_by = 'detector', s.display_name = r.display_name,
              s.aliases = [], s.first_seen_at = datetime(r.first_seen_at)
MERGE (:Option {decision_type: r.decision_type, option_key: r.option_key})
MERGE (c:SchemaChange {change_id: 'proposed:' + r.key})
ON CREATE SET c.action = 'PROPOSED', c.at = datetime(), c.by = 'detector'
MERGE (c)-[:AFFECTS]->(s)
"""

Q_DECISIONS = """
UNWIND $rows AS r
MERGE (d:Decision {decision_id: r.decision_id})
SET d.decision_type = r.decision_type, d.stage = r.stage, d.decided_at = datetime(r.decided_at),
    d.recorded_at = coalesce(d.recorded_at, datetime()), d.detection_method = r.detection_method,
    d.detection_confidence = r.detection_confidence, d.source_system = r.source_system,
    d.scenario_id = r.scenario_id
WITH d, r
MATCH (t:DecisionType {key: r.decision_type})
MERGE (d)-[:INSTANCE_OF]->(t)
"""

Q_CONTEXTS = """
UNWIND $rows AS r
MERGE (c:Context {context_id: r.context_id})
SET c += r.attrs, c.summary_text = r.summary_text, c.scenario_id = r.scenario_id
WITH c, r
MATCH (d:Decision {decision_id: r.decision_id})
MERGE (d)-[:HAD_CONTEXT]->(c)
"""

Q_CONSIDERED = """
UNWIND $rows AS r
MATCH (d:Decision {decision_id: r.decision_id})
MATCH (o:Option {decision_type: r.decision_type, option_key: r.option_key})
MERGE (d)-[c:CONSIDERED]->(o)
SET c.status = r.status, c.amount_usd = r.amount_usd
"""

Q_MADE_BY = """
UNWIND $rows AS r
MATCH (d:Decision {decision_id: r.decision_id}), (a:Actor {actor_id: r.actor_id})
MERGE (d)-[m:MADE_BY]->(a)
SET m.role = r.role
"""

Q_ABOUT = """
UNWIND $rows AS r
MATCH (d:Decision {decision_id: r.decision_id}), (e:Entity {entity_id: r.entity_id})
MERGE (d)-[:ABOUT]->(e)
"""

Q_PRECEDED_BY = """
UNWIND $rows AS r
MATCH (a:Decision {decision_id: r.from}), (b:Decision {decision_id: r.to})
MERGE (a)-[:PRECEDED_BY]->(b)
"""

Q_OVERRIDES = """
UNWIND $rows AS r
MATCH (a:Decision {decision_id: r.from}), (b:Decision {decision_id: r.to})
MERGE (a)-[o:OVERRIDES]->(b)
SET o.detected_at = datetime(r.detected_at)
"""

Q_UNDER_POLICY = """
UNWIND $rows AS r
MATCH (d:Decision {decision_id: r.decision_id}), (p:Policy {policy_id: r.policy_id, version: r.version})
MERGE (d)-[:UNDER_POLICY]->(p)
"""

Q_OUTCOMES = """
UNWIND $rows AS r
MERGE (o:Outcome {outcome_id: r.outcome_id})
SET o.outcome_type = r.outcome_type, o.occurred_at = datetime(r.occurred_at),
    o.recorded_at = coalesce(o.recorded_at, datetime()), o.value_usd = r.value_usd, o.scenario_id = r.scenario_id
"""

Q_EVIDENCED_BY = """
UNWIND $rows AS r
MATCH (n:{label} {{id_prop}: r.node_id}), (e:Event {event_id: r.event_id})
MERGE (n)-[:EVIDENCED_BY]->(e)
"""

Q_LED_TO = """
UNWIND $rows AS r
MATCH (d:Decision {decision_id: r.decision_id}), (o:Outcome {outcome_id: r.outcome_id})
MERGE (d)-[l:LED_TO]->(o)
SET l.confidence = r.confidence, l.attribution_method = r.attribution_method, l.window_days = r.window_days,
    l.linked_at = coalesce(l.linked_at, datetime())
"""


def load_registry(driver: Driver, database: str) -> Registry:
    records = driver.execute_query(
        "MATCH (s:SchemaElement) WHERE s.kind IN ['OPTION', 'OUTCOME_TYPE'] "
        "RETURN s.kind AS kind, s.key AS key, s.decision_type AS dt, s.status AS status, "
        "s.default_window_days AS window", database_=database).records
    options: dict[str, dict[str, str]] = {}
    windows: dict[str, int] = {}
    for r in records:
        if r["kind"] == "OPTION":
            options.setdefault(r["dt"], {})[r["key"][len(r["dt"]) + 1:]] = r["status"]
        else:
            windows[r["key"].removeprefix("outcome.")] = r["window"]
    return Registry(options, windows)


def write(driver: Driver, database: str, rows: Rows, log: Callable[[str], None] = print) -> None:
    def run(name: str, query: str, data: list, batch: int = BATCH) -> None:
        data = [d for d in data if all(v is not None for k, v in d.items() if k in ("from", "to", "decision_id"))]
        start = time.time()
        for i in range(0, len(data), batch):
            driver.execute_query(query, rows=data[i:i + batch], database_=database)
        log(f"  {name:<16} {len(data):>7}  {time.time() - start:5.1f}s")

    run("events", Q_EVENTS, rows.events, batch=2000)
    for label in sorted({e["label"] for e in rows.entities}):
        run(f"entity:{label}", Q_ENTITIES.replace("{label}", label), [e for e in rows.entities if e["label"] == label])
    run("same_as", Q_SAME_AS, rows.same_as)
    run("actors", Q_ACTORS, list(rows.actors.values()))
    run("policies", Q_POLICIES, [{"policy_id": p, "version": v} for p, v in set(POLICIES.values())])
    run("schema proposals", Q_PROPOSALS, list(rows.schema_proposals.values()))
    run("decisions", Q_DECISIONS, rows.decisions)
    run("contexts", Q_CONTEXTS, rows.contexts)
    run("considered", Q_CONSIDERED, rows.considered)
    run("made_by", Q_MADE_BY, rows.made_by)
    run("about", Q_ABOUT, rows.about)
    run("preceded_by", Q_PRECEDED_BY, rows.preceded_by)
    run("overrides", Q_OVERRIDES, rows.overrides)
    run("under_policy", Q_UNDER_POLICY, rows.under_policy)
    run("outcomes", Q_OUTCOMES, rows.outcomes)
    for kind, id_prop in (("Decision", "decision_id"), ("Outcome", "outcome_id")):
        q = Q_EVIDENCED_BY.replace("{label}", kind).replace("{id_prop}", id_prop)
        run(f"evidenced_by:{kind}", q, [e for e in rows.evidenced_by if e["kind"] == kind])
    run("led_to", Q_LED_TO, rows.led_to)
