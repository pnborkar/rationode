// Loads an Events-tab set into Neo4j. The rows were produced by the Python pipeline
// (rationode.sim.stories); these are the same Cypher writes as pipeline/src/rationode/pipeline/write.py.
import { contextText, encode, type Context } from "./features";
import { query } from "./neo4j";

export type Rows = Record<string, Record<string, unknown>[]>;

const Q = {
  events: `UNWIND $rows AS r
    MERGE (e:Event {event_id: r.event_id})
    SET e.source_system = r.source_system, e.event_type = r.event_type, e.occurred_at = datetime(r.occurred_at),
        e.payload_json = r.payload_json, e.payload_ref = 'inline:payload_json',
        e.charge_id = r.charge_id, e.ticket_id = r.ticket_id, e.dispute_id = r.dispute_id,
        e.stripe_customer_id = r.stripe_customer_id, e.email = r.email, e.scenario_id = r.scenario_id,
        e.canonical_type = r.canonical_type, e.data_json = r.data_json,
        e.source_file = r.source_file, e.source_row = r.source_row, e.batch_id = r.batch_id,
        e.source_name = r.source_name`,
  entities: (label: string) => `UNWIND $rows AS r
    MERGE (e:Entity {entity_id: r.entity_id})
    SET e:${label}, e.source_system = r.source_system, e.source_key = r.source_key, e.scenario_id = r.scenario_id
    SET e += r.props`,
  same_as: `UNWIND $rows AS r
    MATCH (a:Entity {entity_id: r.from}), (b:Entity {entity_id: r.to})
    MERGE (a)-[s:SAME_AS]->(b) SET s.confidence = r.confidence, s.method = r.method`,
  actors: `UNWIND $rows AS r
    MERGE (a:Actor {actor_id: r.actor_id})
    SET a.kind = r.kind, a.version = r.version, a.name = r.name, a.team = r.team, a.scenario_id = r.scenario_id`,
  schema_proposals: `UNWIND $rows AS r
    MERGE (s:SchemaElement {key: r.key})
    ON CREATE SET s.kind = 'OPTION', s.status = 'PROPOSED', s.decision_type = r.decision_type, s.version = 1,
                  s.created_at = datetime(), s.created_by = 'detector', s.display_name = r.display_name,
                  s.aliases = [], s.first_seen_at = datetime(r.first_seen_at)
    MERGE (:Option {decision_type: r.decision_type, option_key: r.option_key})`,
  decisions: `UNWIND $rows AS r
    MERGE (d:Decision {decision_id: r.decision_id})
    SET d.decision_type = r.decision_type, d.stage = r.stage, d.decided_at = datetime(r.decided_at),
        d.recorded_at = coalesce(d.recorded_at, datetime()), d.detection_method = r.detection_method,
        d.detection_confidence = r.detection_confidence, d.source_system = r.source_system,
        d.scenario_id = r.scenario_id, d.rationale = r.rationale, d.details_json = r.details_json
    // A decision type first seen in a mapping (§23.8) is created PROPOSED; known types are left as they are.
    WITH d, r MERGE (t:DecisionType {key: r.decision_type})
      ON CREATE SET t.status = 'PROPOSED', t.created_by = 'mapping', t.created_at = datetime(),
                    t.display_name = replace(r.decision_type, '_', ' ')
    MERGE (d)-[:INSTANCE_OF]->(t)`,
  contexts: `UNWIND $rows AS r
    MERGE (c:Context {context_id: r.context_id})
    SET c += r.attrs, c.summary_text = r.summary_text, c.scenario_id = r.scenario_id, c.features = r.features,
        c.embedding_text = r.embedding_text
    WITH c, r MATCH (d:Decision {decision_id: r.decision_id}) MERGE (d)-[:HAD_CONTEXT]->(c)`,
  considered: `UNWIND $rows AS r
    MATCH (d:Decision {decision_id: r.decision_id})
    MATCH (o:Option {decision_type: r.decision_type, option_key: r.option_key})
    MERGE (d)-[c:CONSIDERED]->(o) SET c.status = r.status, c.amount_usd = r.amount_usd`,
  made_by: `UNWIND $rows AS r
    MATCH (d:Decision {decision_id: r.decision_id}), (a:Actor {actor_id: r.actor_id})
    MERGE (d)-[m:MADE_BY]->(a) SET m.role = r.role`,
  about: `UNWIND $rows AS r
    MATCH (d:Decision {decision_id: r.decision_id}), (e:Entity {entity_id: r.entity_id})
    MERGE (d)-[:ABOUT]->(e)`,
  preceded_by: `UNWIND $rows AS r
    MATCH (a:Decision {decision_id: r.from}), (b:Decision {decision_id: r.to})
    MERGE (a)-[:PRECEDED_BY]->(b)`,
  overrides: `UNWIND $rows AS r
    MATCH (a:Decision {decision_id: r.from}), (b:Decision {decision_id: r.to})
    MERGE (a)-[o:OVERRIDES]->(b) SET o.detected_at = datetime(r.detected_at)`,
  under_policy: `UNWIND $rows AS r
    MATCH (d:Decision {decision_id: r.decision_id}), (p:Policy {policy_id: r.policy_id, version: r.version})
    MERGE (d)-[:UNDER_POLICY]->(p)`,
  outcomes: `UNWIND $rows AS r
    MERGE (o:Outcome {outcome_id: r.outcome_id})
    SET o.outcome_type = r.outcome_type, o.occurred_at = datetime(r.occurred_at),
        o.recorded_at = coalesce(o.recorded_at, datetime()), o.value_usd = r.value_usd, o.scenario_id = r.scenario_id,
        o.polarity = r.polarity`,
  evidenced_by: (label: string, idProp: string) => `UNWIND $rows AS r
    MATCH (n:${label} {${idProp}: r.node_id}), (e:Event {event_id: r.event_id})
    MERGE (n)-[:EVIDENCED_BY]->(e)`,
  links: {
    PAID_WITH: `UNWIND $rows AS r
      MATCH (a:Entity {entity_id: r.from}), (b:Entity {entity_id: r.to}) MERGE (a)-[:PAID_WITH]->(b)`,
    FROM_DEVICE: `UNWIND $rows AS r
      MATCH (a:Entity {entity_id: r.from}), (b:Entity {entity_id: r.to})
      MERGE (a)-[l:FROM_DEVICE]->(b) SET l.ip_country = r.ip_country`,
    USED: `UNWIND $rows AS r
      MATCH (a:Entity {entity_id: r.from}), (b:Entity {entity_id: r.to})
      MERGE (a)-[u:USED]->(b)
      ON CREATE SET u.first_seen = datetime(r.at), u.last_seen = datetime(r.at)
      SET u.first_seen = CASE WHEN datetime(r.at) < u.first_seen THEN datetime(r.at) ELSE u.first_seen END,
          u.last_seen = CASE WHEN datetime(r.at) > u.last_seen THEN datetime(r.at) ELSE u.last_seen END`,
    // Generic subjects (§23.8): a nested subject belongs to its parent (an offer to its application).
    PART_OF: `UNWIND $rows AS r
      MATCH (a:Entity {entity_id: r.from}), (b:Entity {entity_id: r.to}) MERGE (a)-[:PART_OF]->(b)`,
  } as Record<string, string>,
  // The same card or device already seen in another scenario (e.g. history): link, never merge.
  sameIdentity: `MATCH (x:Entity {scenario_id: $scenario}) WHERE x:Card OR x:Device
    MATCH (h:Entity {source_system: x.source_system, source_key: x.source_key}) WHERE h.scenario_id <> $scenario
    MERGE (x)-[s:SAME_AS]->(h)
    SET s.confidence = 1.0, s.method = CASE WHEN x:Card THEN 'FINGERPRINT' ELSE 'DEVICE_ID' END`,
  led_to: `UNWIND $rows AS r
    MATCH (d:Decision {decision_id: r.decision_id}), (o:Outcome {outcome_id: r.outcome_id})
    MERGE (d)-[l:LED_TO]->(o)
    SET l.confidence = r.confidence, l.attribution_method = r.attribution_method, l.window_days = r.window_days,
        l.linked_at = coalesce(l.linked_at, datetime())`,
};

const hasEnds = (r: Record<string, unknown>) =>
  ["from", "to", "decision_id"].every((k) => !(k in r) || r[k] !== null);

export async function writeRows(rows: Rows): Promise<void> {
  const run = async (cypher: string, data: Record<string, unknown>[] = []) => {
    const clean = data.filter(hasEnds);
    if (clean.length) await query(cypher, { rows: clean });
  };
  // Context feature vectors (same encoding as the Python analytics), so loaded decisions can be precedent.
  const decisionType = new Map((rows.decisions ?? []).map((d) => [d.decision_id, d.decision_type as string]));
  // Also the context text, so find_precedent's full-text search can find loaded decisions.
  const contexts = await Promise.all((rows.contexts ?? []).map(async (c) => {
    const type = decisionType.get(c.decision_id as string) ?? "";
    return { ...c, features: await encode(type, c.attrs as Context), embedding_text: contextText(type, c.attrs as Context) };
  }));

  await run(Q.events, rows.events);
  for (const label of new Set((rows.entities ?? []).map((e) => e.label as string))) {
    await run(Q.entities(label), (rows.entities ?? []).filter((e) => e.label === label));
  }
  await run(Q.same_as, rows.same_as);
  await run(Q.actors, rows.actors);
  await run(Q.schema_proposals, rows.schema_proposals);
  await run(Q.decisions, rows.decisions);
  await run(Q.contexts, contexts);
  await run(Q.considered, rows.considered);
  await run(Q.made_by, rows.made_by);
  await run(Q.about, rows.about);
  await run(Q.preceded_by, rows.preceded_by);
  await run(Q.overrides, rows.overrides);
  await run(Q.under_policy, rows.under_policy);
  await run(Q.outcomes, rows.outcomes);
  await run(Q.evidenced_by("Decision", "decision_id"), (rows.evidenced_by ?? []).filter((e) => e.kind === "Decision"));
  await run(Q.evidenced_by("Outcome", "outcome_id"), (rows.evidenced_by ?? []).filter((e) => e.kind === "Outcome"));
  await run(Q.led_to, rows.led_to);
  for (const [kind, cypher] of Object.entries(Q.links)) await run(cypher, (rows.links ?? []).filter((l) => l.type === kind));
  const scenario = rows.decisions?.[0]?.scenario_id ?? rows.events?.[0]?.scenario_id;
  if (scenario && scenario !== "history") await query(Q.sameIdentity, { scenario });
}

// Delete a scenario's nodes (never 'history'); returns how many were removed.
export async function removeScenario(scenario: string): Promise<number> {
  if (scenario === "history") throw new Error("refusing to delete the history scenario");
  let removed = 0;
  for (const label of ["Event", "Decision", "Context", "Entity", "Outcome", "Actor"]) {
    // In chunks of 10,000 until none are left (a tenant's history holds far more than one chunk).
    for (let n = -1; n !== 0;) {
      const [r] = await query<{ n: number }>(
        `MATCH (n:${label} {scenario_id: $scenario}) WITH n LIMIT 10000 DETACH DELETE n RETURN count(*) AS n`,
        { scenario },
      );
      n = r?.n ?? 0;
      removed += n;
    }
  }
  return removed;
}
