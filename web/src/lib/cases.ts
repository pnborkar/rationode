// Cases for the generic Live tab (demo spec §23.8, refined option C). A case is a subject that needs a decision of
// some type, with the facts known at that moment. First source: replay. A real past decision from the loaded data is
// shown as if new (only what was known then); its real decision and outcome stay hidden until "reveal".
import { prefixOf } from "./features";
import { query, baseScenario } from "./neo4j";

const META = new Set(["context_id", "scenario_id", "summary_text", "features", "embedding", "embedding_text", "embedding_model"]);

export type Case = {
  id: string; decision_type: string; decided_at: string;
  // parent.parts: how many subjects belong to it. A small parent is a container (a permit and its declarations); a
  // large one is a grouping (a budget with thousands of declarations): §23.10 "BPIC 2020 loaded".
  subject: { id: string; label: string; key: string }; parent: { id: string; label: string; key: string; parts: number } | null;
  facts: Record<string, unknown>;                       // known at decision time
  options: { option: string; n: number }[];             // what was chosen for this decision type in the data
  details: string[];                                    // detail names recorded with such decisions (e.g. terms)
  related: string[];                                    // decisions about the same subject or parent (kept out of precedent)
};

// A random past FINAL decision of a type a mapping introduced (any domain), with at least one outcome.
// A parent with at most this many parts is the case's container; with more, a grouping.
export const CONTAINER_MAX = 20;

export async function replayCase(decisionType?: string): Promise<Case | null> {
  const [c] = await query<{ id: string; type: string; at: string; ctx: Record<string, unknown>; s: Case["subject"]; p: Case["parent"] }>(
    `MATCH (t:DecisionType {created_by: 'mapping'})
     MATCH (d:Decision {scenario_id: $s, decision_type: t.key, stage: 'FINAL'})-[:HAD_CONTEXT]->(c:Context)
     WHERE ($type IS NULL OR d.decision_type = $type) AND EXISTS { (d)-[:LED_TO]->() }
     WITH d, c, rand() AS r ORDER BY r LIMIT 1
     MATCH (d)-[:ABOUT]->(x:Entity) WHERE NOT EXISTS { (x)<-[:PART_OF]-(:Entity)<-[:ABOUT]-(d) }
     WITH d, c, x ORDER BY CASE WHEN (x)-[:PART_OF]->() THEN 0 ELSE 1 END LIMIT 1
     OPTIONAL MATCH (x)-[:PART_OF]->(p:Entity)
     RETURN d.decision_id AS id, d.decision_type AS type, toString(d.decided_at) AS at, properties(c) AS ctx,
            {id: x.entity_id, label: head([l IN labels(x) WHERE l <> 'Entity']), key: split(x.source_key, ':')[1]} AS s,
            CASE WHEN p IS NULL THEN null ELSE {id: p.entity_id, label: head([l IN labels(p) WHERE l <> 'Entity']), key: split(p.source_key, ':')[1],
                                               parts: COUNT { (:Entity)-[:PART_OF]->(p) }} END AS p`,
    { s: baseScenario(), type: decisionType ?? null });
  if (!c) return null;
  const prefix = prefixOf(c.type);
  const [options, details, related] = await Promise.all([
    query<{ option: string; n: number }>(
      `MATCH (d:Decision {scenario_id: $s, decision_type: $t, stage: 'FINAL'})-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
       RETURN o.option_key AS option, count(*) AS n ORDER BY n DESC`, { s: baseScenario(), t: c.type }),
    query<{ keys: string[] }>(
      `MATCH (d:Decision {scenario_id: $s, decision_type: $t}) WHERE d.details_json IS NOT NULL
       WITH d LIMIT 50 RETURN collect(DISTINCT keys(apoc.convert.fromJsonMap(d.details_json))) AS keys`, { s: baseScenario(), t: c.type }),
    query<{ id: string }>(
      // Kept out of precedent (they'd give the answer away): decisions about the case's subject, and about its parent
      // when the parent is a small container. Under a large grouping, the others are other cases: fair precedent.
      `MATCH (d:Decision {scenario_id: $s})-[:ABOUT]->(e:Entity) WHERE e.entity_id IN $ids RETURN DISTINCT d.decision_id AS id`,
      { s: baseScenario(), ids: [c.s.id, ...(c.p && c.p.parts <= CONTAINER_MAX ? [c.p.id] : [])] }),
  ]);
  return {
    id: c.id, decision_type: c.type, decided_at: c.at, subject: c.s, parent: c.p,
    facts: Object.fromEntries(Object.entries(c.ctx).filter(([k, v]) => k.startsWith(prefix) && !META.has(k) && v !== null && v !== "")),
    options, details: [...new Set((details[0]?.keys ?? []).flat())].sort(), related: related.map((r) => r.id),
  };
}

// What really happened: the real decision (option, amount, details, who) and its outcomes.
export async function revealCase(id: string) {
  const [r] = await query<{ option: string | null; amount: number | null; details: string | null; actor: string | null; kind: string | null;
                            at: string; outcomes: { type: string; polarity: string | null; value: number | null }[] }>(
    `MATCH (d:Decision {decision_id: $id, scenario_id: $s})
     OPTIONAL MATCH (d)-[k:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
     OPTIONAL MATCH (d)-[:MADE_BY]->(a:Actor)
     WITH d, head(collect(o.option_key)) AS option, head(collect(k.amount_usd)) AS amount, head(collect(a)) AS a
     RETURN option, amount, d.details_json AS details, coalesce(a.name, a.actor_id) AS actor, a.kind AS kind, toString(d.decided_at) AS at,
            [(d)-[:LED_TO]->(out:Outcome) | {type: out.outcome_type, polarity: out.polarity, value: out.value_usd}] AS outcomes`,
    { id, s: baseScenario() });
  return r ? { ...r, details: r.details ? JSON.parse(r.details) : null } : null;
}
