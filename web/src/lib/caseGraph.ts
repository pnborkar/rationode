import { query } from "./neo4j";

export type GraphNode = { id: string; kind: string; label: string; detail?: string; option?: string | null; outcomes?: string[] };
export type GraphRel = { id: string; from: string; to: string; type: string };

// A customer's neighbourhood in the decision graph: the customer, their charges and tickets,
// every decision about them, and what those decisions led to.
export async function customerGraph(email: string) {
  const rows = await query<{
    customer: string; name: string;
    decisions: { id: string; type: string; stage: string; at: string; actor: string; option: string | null;
                 about: string[]; outcomes: { id: string; type: string; value: number | null }[] }[];
    entities: { id: string; kind: string; key: string }[];
  }>(
    `MATCH (c:Customer:Entity {source_system: 'stripe', email: $email})
     OPTIONAL MATCH (d:Decision)-[:ABOUT]->(c)
     OPTIONAL MATCH (d)-[:MADE_BY]->(a:Actor)
     OPTIONAL MATCH (d)-[k:CONSIDERED]->(o:Option) WHERE k.status IN ['CHOSEN', 'PROPOSED']
     OPTIONAL MATCH (d)-[:ABOUT]->(e:Entity) WHERE e <> c
     OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome)
     WITH c, d, a, head(collect(DISTINCT o.option_key)) AS option,
          collect(DISTINCT e) AS ents, collect(DISTINCT out) AS outs
     WITH c, collect(CASE WHEN d IS NULL THEN null ELSE {
            id: d.decision_id, type: d.decision_type, stage: d.stage, at: toString(d.decided_at), actor: a.name,
            option: option, about: [x IN ents | x.entity_id],
            outcomes: [x IN outs | {id: x.outcome_id, type: x.outcome_type, value: x.value_usd}]} END) AS decisions,
          apoc.coll.toSet(apoc.coll.flatten(collect([x IN ents | {id: x.entity_id, kind: head([l IN labels(x) WHERE l <> 'Entity']),
                                                                   key: x.source_key}]))) AS entities
     RETURN c.entity_id AS customer, c.name AS name, decisions, entities`,
    { email },
  );
  const r = rows[0];
  if (!r) return null;

  const nodes: GraphNode[] = [{ id: r.customer, kind: "customer", label: r.name, detail: email }];
  const rels: GraphRel[] = [];
  for (const e of r.entities) nodes.push({ id: e.id, kind: e.kind.toLowerCase(), label: e.kind, detail: e.key });
  const seenOutcomes = new Set<string>();
  for (const d of r.decisions.sort((a, b) => a.at.localeCompare(b.at))) {
    nodes.push({ id: d.id, kind: "decision", label: d.type.split(".")[1].replace("_", " "), option: d.option,
                 detail: `${d.stage.toLowerCase()} by ${d.actor} · ${d.at.slice(0, 10)}` });
    rels.push({ id: `${d.id}->${r.customer}`, from: d.id, to: r.customer, type: "ABOUT" });
    for (const e of d.about) rels.push({ id: `${d.id}->${e}`, from: d.id, to: e, type: "ABOUT" });
    for (const o of d.outcomes) {
      if (!seenOutcomes.has(o.id)) {
        seenOutcomes.add(o.id);
        nodes.push({ id: o.id, kind: "outcome", label: o.type.replace("_", " "),
                     detail: o.value != null ? `$${o.value}` : undefined });
      }
      rels.push({ id: `${d.id}->${o.id}`, from: d.id, to: o.id, type: "LED_TO" });
    }
  }
  return { nodes, rels };
}
