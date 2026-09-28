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
  await addPolicyGap(email, nodes, rels);
  return { nodes, rels };
}

// When a customer's fraud screening went against the written policy (e.g. Omar: the tool approved a
// risk-70 signup under rule R-APPROVE-LE75 while the policy says "review 60 and above"), draw why:
// the signals, the rule, the policy branch with a POLICY_GAP link, and past decisions in the same gap.
async function addPolicyGap(email: string, nodes: GraphNode[], rels: GraphRel[]) {
  const [g] = await query<{
    decision: string; chosen: string; risk: number; card_age: number; country: boolean; payload: string;
    policy: string | null; branch: string | null; policy_option: string | null; point: string | null;
  }>(
    `MATCH (:Customer:Entity {source_system: 'stripe', email: $email})<-[:ABOUT]-(d:Decision {decision_type: 'charge.fraud_screen'})
     MATCH (d)-[:HAD_CONTEXT]->(c:Context), (d)-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option), (d)-[:EVIDENCED_BY]->(e:Event)
     MATCH (d)-[:AT_POINT]->(p:DecisionPoint {tree_id: 'tree:charge.fraud_screen:policy:policy'})
     OPTIONAL MATCH (d)-[:UNDER_POLICY]->(pol:Policy)
     OPTIONAL MATCH (t:DecisionTree {tree_id: p.tree_id})
     WITH d, c, o, e, p, pol, t WHERE p.policy_option <> o.option_key
     RETURN d.decision_id AS decision, o.option_key AS chosen, c.\`charge.risk_score\` AS risk,
            c.\`charge.card_age_days\` AS card_age, c.\`charge.country_match\` AS country, e.payload_json AS payload,
            t.policy_text AS policy, p.path_label AS branch, p.policy_option AS policy_option, p.point_id AS point
     LIMIT 1`,
    { email },
  );
  if (!g) return;
  const rule = (JSON.parse(g.payload) as { rule_id?: string }).rule_id ?? "rule";
  const [pattern] = await query<{ n: number; disputed: number }>(
    `MATCH (h:Decision {scenario_id: 'history'})-[:AT_POINT]->(:DecisionPoint {point_id: $point})
     MATCH (h)-[:CONSIDERED {status: 'CHOSEN'}]->(:Option {option_key: $chosen})
     WITH h, EXISTS { (h)-[:LED_TO]->(:Outcome {outcome_type: 'dispute_filed'}) } AS disputed
     RETURN count(h) AS n, sum(CASE WHEN disputed THEN 1 ELSE 0 END) AS disputed`,
    { point: g.point, chosen: g.chosen },
  );
  const sample = await query<{ id: string; outcomes: string[]; risk: number }>(
    `MATCH (h:Decision {scenario_id: 'history'})-[:AT_POINT]->(:DecisionPoint {point_id: $point})
     MATCH (h)-[:CONSIDERED {status: 'CHOSEN'}]->(:Option {option_key: $chosen})
     MATCH (h)-[:LED_TO]->(:Outcome {outcome_type: 'dispute_filed'})
     MATCH (h)-[:HAD_CONTEXT]->(c:Context)
     OPTIONAL MATCH (h)-[:LED_TO]->(o:Outcome)
     RETURN h.decision_id AS id, collect(DISTINCT o.outcome_type) AS outcomes, c.\`charge.risk_score\` AS risk
     ORDER BY abs(c.\`charge.risk_score\` - $risk), id LIMIT 10`,
    { point: g.point, chosen: g.chosen, risk: g.risk },
  );

  const id = (k: string) => `${g.decision}~${k}`;
  nodes.push(
    { id: id("signals"), kind: "signals", label: `Risk ${g.risk}`,
      detail: `risk score ${g.risk} · card ${g.card_age} days old · card country ${g.country ? "matches" : "does not match"}` },
    { id: id("rule"), kind: "rule", label: rule, detail: `fraud tool rule that fired: ${g.chosen}` },
    { id: id("policy"), kind: "policy", label: `Policy: ${g.policy_option}`,
      detail: `${g.policy ?? ""} Branch: ${g.branch}` },
  );
  rels.push(
    { id: `${g.decision}->signals`, from: g.decision, to: id("signals"), type: "HAD_CONTEXT" },
    { id: `${g.decision}->rule`, from: g.decision, to: id("rule"), type: "FIRED" },
    { id: `${g.decision}->policy`, from: g.decision, to: id("policy"), type: "POLICY_GAP" },
  );
  if (pattern && sample.length) {
    const rate = pattern.n ? Math.round((pattern.disputed / pattern.n) * 1000) / 10 : 0;
    nodes.push({ id: id("pattern"), kind: "pattern", label: `${pattern.n.toLocaleString()} like this`,
                 detail: `${pattern.n.toLocaleString()} past ${g.chosen} decisions in the same branch; ${pattern.disputed} (${rate}%) led to disputes` });
    rels.push({ id: `${g.decision}->pattern`, from: id("policy"), to: id("pattern"), type: "SAME_GAP" });
    for (const h of sample) {
      nodes.push({ id: h.id, kind: "precedent", label: "past decision", option: g.chosen, outcomes: h.outcomes,
                   detail: `risk ${h.risk} · ${h.id}` });
      rels.push({ id: `${id("pattern")}->${h.id}`, from: id("pattern"), to: h.id, type: "INCLUDES" });
    }
  }
}
