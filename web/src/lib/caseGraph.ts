import neo4j from "neo4j-driver";
import { isType } from "./eventFields";
import { liveScenario } from "./live";
import { fraudPolicyTree, query, baseScenario } from "./neo4j";

export type GraphNode = { id: string; kind: string; label: string; detail?: string; option?: string | null; outcomes?: string[];
                          tone?: "good" | "bad" | "mixed" | null };   // any domain (§23.8): colour from outcome polarity
export type GraphRel = { id: string; from: string; to: string; type: string };

// Captions that say what happened, including the money.
function outcomeLabel(type: string, value: number | null): string {
  const usd = value != null ? ` $${value}` : "";
  switch (type) {
    case "refund_cost": return `Refunded${usd}`;
    case "dispute_filed": return `Dispute filed${usd}`;
    case "dispute_lost": return `Dispute lost${usd}`;
    case "dispute_won": return "Dispute won";
    case "churn": return "Churned";
    case "renewal": return "Renewed";
    default: return type.replace("_", " ");
  }
}

// A customer's neighbourhood in the decision graph: the customer, their charges and tickets,
// every decision about them, and what those decisions led to.
export async function customerGraph(email: string) {
  const rows = await query<{
    customer: string; name: string;
    decisions: { id: string; type: string; stage: string; at: string; actor: string; option: string | null;
                 amount: number | null; rationale: string | null;
                 about: string[]; outcomes: { id: string; type: string; value: number | null; charge: string | null }[] }[];
    entities: { id: string; kind: string; key: string; amount: number | null }[];
  }>(
    `MATCH (c:Customer:Entity {source_system: 'stripe', email: $email})
     OPTIONAL MATCH (d:Decision)-[:ABOUT]->(c)
     OPTIONAL MATCH (d)-[:MADE_BY]->(a:Actor)
     OPTIONAL MATCH (d)-[k:CONSIDERED]->(o:Option) WHERE k.status IN ['CHOSEN', 'PROPOSED']
     OPTIONAL MATCH (d)-[:ABOUT]->(e:Entity) WHERE e <> c
     OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome)
     WITH c, d, a, head(collect(DISTINCT o.option_key)) AS option, head(collect(k.amount_usd)) AS amount,
          collect(DISTINCT e) AS ents, collect(DISTINCT out) AS outs
     WITH c, collect(CASE WHEN d IS NULL THEN null ELSE {
            id: d.decision_id, type: d.decision_type, stage: d.stage, at: toString(d.decided_at), actor: a.name,
            option: option, amount: amount, rationale: d.rationale, about: [x IN ents | x.entity_id],
            outcomes: [x IN outs | {id: x.outcome_id, type: x.outcome_type, value: x.value_usd,
                                    charge: [(x)-[:EVIDENCED_BY]->(ev:Event) | ev.charge_id][0]}]} END) AS decisions,
          apoc.coll.toSet(apoc.coll.flatten(collect([x IN ents | {id: x.entity_id, kind: head([l IN labels(x) WHERE l <> 'Entity']),
                                                                   key: x.source_key, amount: x.amount_usd}]))) AS entities
     RETURN c.entity_id AS customer, c.name AS name, decisions, entities`,
    { email },
  );
  const r = rows[0];
  if (!r) return null;

  const nodes: GraphNode[] = [{ id: r.customer, kind: "customer", label: r.name, detail: email }];
  const rels: GraphRel[] = [];
  for (const e of r.entities) {
    const label = e.kind === "Charge" && e.amount != null ? `Charge $${e.amount}`
      : e.kind === "Ticket" ? `Ticket #${e.key.replace(/^ticket:/, "")}` : e.kind;
    nodes.push({ id: e.id, kind: e.kind.toLowerCase(), label, detail: e.key });
  }
  const chargeEntity = new Map(r.entities.filter((e) => e.kind === "Charge").map((e) => [e.key, e.id]));
  const seenOutcomes = new Set<string>();
  for (const d of r.decisions.sort((a, b) => a.at.localeCompare(b.at))) {
    // Live decisions (captured by the gateway and the Zendesk webhook) keep the live tab's look: the AI's
    // proposal and the rep's final decision.
    const liveNode = d.id.startsWith(`${liveScenario()}|`) && d.type === "support.complaint_resolution";
    const opt = (d.option ?? "").replaceAll("_", " ");
    nodes.push(liveNode
      ? { id: d.id, kind: d.stage === "PROPOSAL" ? "proposal" : "final", option: d.option,
          label: d.stage === "PROPOSAL" ? `AI: ${opt}` : opt.replace(/^./, (c) => c.toUpperCase()),
          detail: (d.stage === "PROPOSAL" ? `AI proposal by ${d.actor} (live, via the MCP gateway) · ${d.at.slice(0, 10)}`
            : `final by ${d.actor} (live, via the Zendesk webhook) · ${d.at.slice(0, 10)}`)
            + (d.amount ? ` · $${d.amount}` : "") + (d.rationale ? ` · reason: ${d.rationale}` : "") }
      : { id: d.id, kind: "decision", label: d.type.split(".")[1].replace("_", " "), option: d.option,
          detail: `${d.stage.toLowerCase()} by ${d.actor} · ${d.at.slice(0, 10)}` + (d.rationale ? ` · reason: ${d.rationale}` : "") });
    rels.push({ id: `${d.id}->${r.customer}`, from: d.id, to: r.customer, type: "ABOUT" });
    for (const e of d.about) rels.push({ id: `${d.id}->${e}`, from: d.id, to: e, type: "ABOUT" });
    for (const o of d.outcomes) {
      if (!seenOutcomes.has(o.id)) {
        seenOutcomes.add(o.id);
        nodes.push({ id: o.id, kind: "outcome", label: outcomeLabel(o.type, o.value),
                     detail: o.value != null ? `${o.type.replace("_", " ")} · $${o.value}` : o.type.replace("_", " ") });
        // A refund points at the charge it refunded, so "already refunded" is visible in the graph.
        const refunded = o.type === "refund_cost" && o.charge ? chargeEntity.get(o.charge) : undefined;
        if (refunded) rels.push({ id: `${o.id}->${refunded}`, from: o.id, to: refunded, type: "REFUNDS" });
      }
      rels.push({ id: `${d.id}->${o.id}`, from: d.id, to: o.id, type: "LED_TO" });
    }
  }
  // A final decision and the AI proposal it followed: APPROVED, or OVERRIDES when the rep chose differently.
  const ids = r.decisions.map((d) => d.id);
  if (ids.length) {
    const follows = await query<{ from: string; to: string; overrides: boolean }>(
      `MATCH (a:Decision {stage: 'FINAL'})-[:PRECEDED_BY]->(b:Decision {stage: 'PROPOSAL'})
       WHERE a.decision_id IN $ids AND b.decision_id IN $ids
       RETURN a.decision_id AS from, b.decision_id AS to, EXISTS { (a)-[:OVERRIDES]->(b) } AS overrides`, { ids });
    for (const f of follows) {
      rels.push({ id: `${f.from}~follows`, from: f.from, to: f.to, type: f.overrides ? "OVERRIDES" : "APPROVED" });
    }
  }
  await addUsage(r.customer, nodes, rels);
  await addPolicyGap(email, nodes, rels);
  await addIdentity(r.customer, nodes, rels);
  return { nodes, rels };
}

// Weekly viewing from the Streamly app. Weeks with viewing on or after a disputed charge contradict an
// "I canceled" (subscription_canceled) dispute, e.g. Nina kept watching after the renewal she disputed.
async function addUsage(customerId: string, nodes: GraphNode[], rels: GraphRel[]) {
  const weeks = await query<{ id: string; week: string; hours: number; titles: number }>(
    `MATCH (c:Customer:Entity {entity_id: $customer})
     MATCH (e:Event {stripe_customer_id: c.source_key}) WHERE ${isType("e", "usage.weekly")}
     WITH e, coalesce(apoc.convert.fromJsonMap(e.data_json), apoc.convert.fromJsonMap(e.payload_json)) AS p
     RETURN e.event_id AS id, p.week_start AS week, p.hours_watched AS hours, p.titles_watched AS titles
     ORDER BY week`,
    { customer: customerId },
  );
  if (!weeks.length) return;
  const disputes = await query<{ dispute: string; charged: string }>(
    `MATCH (:Customer:Entity {entity_id: $customer})<-[:ABOUT]-(:Decision)-[:ABOUT]->(dp:Dispute)
     WHERE dp.category = 'subscription_canceled'
     MATCH (:Decision)-[:ABOUT]->(dp)
     MATCH (ch:Charge)<-[:ABOUT]-(:Decision)-[:ABOUT]->(dp)
     MATCH (ev:Event {charge_id: ch.source_key}) WHERE ${isType("ev", "charge.succeeded")}
     RETURN DISTINCT dp.entity_id AS dispute, toString(date(ev.occurred_at)) AS charged`,
    { customer: customerId },
  );
  for (const w of weeks) {
    nodes.push({ id: w.id, kind: "usage", label: `${w.hours} h`,
                 detail: `week of ${w.week} · ${w.hours} hours · ${w.titles} titles (Streamly app)` });
    rels.push({ id: `${customerId}->${w.id}`, from: customerId, to: w.id, type: "WATCHED" });
    for (const d of disputes) {
      // A week counts if it ends on or after the disputed charge and has viewing.
      const weekEnd = new Date(new Date(w.week).getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
      if (w.hours > 0 && weekEnd >= d.charged) {
        rels.push({ id: `${w.id}->${d.dispute}`, from: w.id, to: d.dispute, type: "CONTRADICTS" });
      }
    }
  }
}

// The identity behind the account: its cards and devices, and other accounts sharing them (in any scenario,
// through SAME_AS), marked by how their charges ended. Shared identifiers are where fraud patterns show.
async function addIdentity(customerId: string, nodes: GraphNode[], rels: GraphRel[]) {
  const rows = await query<{ id: string; kind: string; key: string; country: string | null;
                             others: { id: string; name: string | null; unauthorized: boolean; declined: boolean }[] }>(
    `MATCH (c:Customer:Entity {entity_id: $customer})-[:USED]->(x)
     OPTIONAL MATCH (x)-[:SAME_AS*0..2]-(x2)<-[:USED]-(o:Customer {source_system: 'stripe'}) WHERE o <> c
     WITH x, o,
          EXISTS { (o)<-[:ABOUT]-(:Decision)-[:ABOUT]->(:Dispute {category: 'unauthorized'}) } AS unauthorized,
          EXISTS { (o)<-[:ABOUT]-(:Decision {decision_type: 'charge.fraud_screen'})-[:CONSIDERED {status: 'CHOSEN'}]->(:Option {option_key: 'decline'}) } AS declined
     WITH x, collect(DISTINCT CASE WHEN o IS NULL THEN null ELSE
            {id: o.entity_id, name: o.name, unauthorized: unauthorized, declined: declined} END)[..6] AS others
     RETURN x.entity_id AS id, CASE WHEN x:Card THEN 'card' ELSE 'device' END AS kind, x.source_key AS key,
            x.country AS country, others`,
    { customer: customerId },
  );
  const seen = new Set(nodes.map((n) => n.id));
  for (const x of rows) {
    if (!seen.has(x.id)) {
      seen.add(x.id);
      nodes.push({ id: x.id, kind: x.kind, label: x.kind === "card" ? `Card ${x.key.slice(0, 4)}…` : `Device ${x.key.slice(4, 8)}…`,
                   detail: x.kind === "card" ? `card fingerprint ${x.key}${x.country ? ` · ${x.country}` : ""}` : `device ${x.key}` });
    }
    rels.push({ id: `${customerId}->${x.id}`, from: customerId, to: x.id, type: "USED" });
    for (const o of x.others) {
      if (!seen.has(o.id)) {
        seen.add(o.id);
        const flag = o.unauthorized ? "unauthorized dispute" : o.declined ? "fraud decline" : "no fraud outcome";
        nodes.push({ id: o.id, kind: o.unauthorized || o.declined ? "fraud_account" : "account",
                     label: o.name ?? "account", detail: `other account · ${flag}` });
      }
      rels.push({ id: `${o.id}->${x.id}`, from: o.id, to: x.id, type: "USED" });
    }
  }
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
     MATCH (d)-[:AT_POINT]->(p:DecisionPoint {tree_id: $policyTree})
     OPTIONAL MATCH (d)-[:UNDER_POLICY]->(pol:Policy)
     OPTIONAL MATCH (t:DecisionTree {tree_id: p.tree_id})
     WITH d, c, o, e, p, pol, t WHERE p.policy_option <> o.option_key
     RETURN d.decision_id AS decision, o.option_key AS chosen, c.\`charge.risk_score\` AS risk,
            c.\`charge.card_age_days\` AS card_age, c.\`charge.country_match\` AS country, coalesce(e.data_json, e.payload_json) AS payload,
            t.policy_text AS policy, p.path_label AS branch, p.policy_option AS policy_option, p.point_id AS point
     LIMIT 1`,
    { email, policyTree: fraudPolicyTree() },
  );
  if (!g) return;
  const rule = (JSON.parse(g.payload) as { rule_id?: string }).rule_id ?? "rule";
  const [pattern] = await query<{ n: number; disputed: number }>(
    `MATCH (h:Decision {scenario_id: $base})-[:AT_POINT]->(:DecisionPoint {point_id: $point})
     MATCH (h)-[:CONSIDERED {status: 'CHOSEN'}]->(:Option {option_key: $chosen})
     WITH h, EXISTS { (h)-[:LED_TO]->(:Outcome {outcome_type: 'dispute_filed'}) } AS disputed
     RETURN count(h) AS n, sum(CASE WHEN disputed THEN 1 ELSE 0 END) AS disputed`,
    { point: g.point, chosen: g.chosen, base: baseScenario() },
  );
  const sample = await query<{ id: string; outcomes: string[]; risk: number }>(
    `MATCH (h:Decision {scenario_id: $base})-[:AT_POINT]->(:DecisionPoint {point_id: $point})
     MATCH (h)-[:CONSIDERED {status: 'CHOSEN'}]->(:Option {option_key: $chosen})
     MATCH (h)-[:LED_TO]->(:Outcome {outcome_type: 'dispute_filed'})
     MATCH (h)-[:HAD_CONTEXT]->(c:Context)
     OPTIONAL MATCH (h)-[:LED_TO]->(o:Outcome)
     RETURN h.decision_id AS id, collect(DISTINCT o.outcome_type) AS outcomes, c.\`charge.risk_score\` AS risk
     ORDER BY abs(c.\`charge.risk_score\` - $risk), id LIMIT 10`,
    { point: g.point, chosen: g.chosen, risk: g.risk, base: baseScenario() },
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

// Any subject's neighbourhood (demo spec §23.8, phase B): the subject (e.g. a loan application), its parent and its
// parts (PART_OF, e.g. its offers), the decisions about them, what those led to and who decided. The customer graph
// above is Streamly's view (a Stripe customer); this one works for any domain.
// Caps for a subject's graph (any domain): enough to read, never thousands of nodes in the browser.
const GRAPH_MAX_PARTS = 25, GRAPH_MAX_DECISIONS = 200;

// before: only what happened before that moment (a replayed case's graph "so far": nothing that would give the ending
// away); unset: everything.
export async function subjectGraph(entityId: string, before: string | null = null) {
  const [r] = await query<{
    subject: { id: string; label: string; key: string; type: string | null };
    parent: { id: string; label: string; key: string } | null;
    parts: { id: string; label: string; key: string }[]; partCount: number;
    decisions: { id: string; type: string; stage: string; at: string; option: string | null; amount: number | null; about: string;
                 actor: string | null; kind: string | null; rationale: string | null;
                 outcomes: { id: string; type: string; value: number | null; polarity: string | null }[] }[];
  }>(
    `MATCH (s:Entity {entity_id: $id})
     OPTIONAL MATCH (s)-[:PART_OF]->(p:Entity)
     OPTIONAL MATCH (c:Entity)-[:PART_OF]->(s)
     WHERE $before IS NULL OR EXISTS { MATCH (d0:Decision)-[:ABOUT]->(c) WHERE d0.decided_at < datetime($before) }
     // Capped, so a subject with thousands of parts (a budget) draws a readable graph instead of freezing the browser.
     WITH s, p, collect(DISTINCT c) AS allParts
     WITH s, p, allParts[..$maxParts] AS parts, size(allParts) AS partCount
     CALL (s, parts) {
       UNWIND [s] + parts AS x
       MATCH (d:Decision)-[:ABOUT]->(x) WHERE $before IS NULL OR d.decided_at < datetime($before)
       // A decision about a part is also about the subject: once, drawn on its most specific subject (the part).
       WITH d, collect(x) AS xs
       WITH d, coalesce(head([y IN xs WHERE y <> s]), s) AS x
       OPTIONAL MATCH (d)-[k:CONSIDERED]->(o:Option) WHERE k.status IN ['CHOSEN', 'PROPOSED']
       OPTIONAL MATCH (d)-[:MADE_BY]->(a:Actor)
       WITH d, x, head(collect(o.option_key)) AS option, head(collect(k.amount_usd)) AS amount, head(collect(a)) AS a
       OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome) WHERE $before IS NULL OR out.occurred_at < datetime($before)
       WITH d, x, option, amount, a,
            collect(CASE WHEN out IS NULL THEN null ELSE {id: out.outcome_id, type: out.outcome_type, value: out.value_usd, polarity: out.polarity} END) AS outcomes
       ORDER BY d.decided_at
       WITH d, x, option, amount, a, outcomes LIMIT $maxDecisions
       RETURN collect({id: d.decision_id, type: d.decision_type, stage: d.stage, at: toString(d.decided_at), about: x.entity_id,
                       rationale: d.rationale, option: option, amount: amount, actor: coalesce(a.name, a.actor_id), kind: a.kind,
                       outcomes: outcomes}) AS decisions
     }
     RETURN {id: s.entity_id, label: head([l IN labels(s) WHERE l <> 'Entity']), key: s.source_key, type: s.subject_type} AS subject,
            CASE WHEN p IS NULL THEN null ELSE {id: p.entity_id, label: head([l IN labels(p) WHERE l <> 'Entity']), key: p.source_key} END AS parent,
            [c IN parts | {id: c.entity_id, label: head([l IN labels(c) WHERE l <> 'Entity']), key: c.source_key}] AS parts,
            partCount, decisions`,
    { id: entityId, before, maxParts: neo4j.int(GRAPH_MAX_PARTS), maxDecisions: neo4j.int(GRAPH_MAX_DECISIONS) },
  );
  if (!r) return null;
  const short = (key: string) => key.split(":").slice(1).join(":") || key;
  const words = (s: string) => s.replaceAll("_", " ");
  const tone = (ps: (string | null)[]): GraphNode["tone"] =>
    ps.includes("good") && ps.includes("bad") ? "mixed" : ps.includes("good") ? "good" : ps.includes("bad") ? "bad" : null;
  const nodes: GraphNode[] = [{ id: r.subject.id, kind: "customer", label: `${r.subject.label} ${short(r.subject.key)}`,
                                detail: `${r.subject.type ?? r.subject.label} · ${r.subject.key}` }];
  const rels: GraphRel[] = [];
  if (r.parent) {
    nodes.push({ id: r.parent.id, kind: "subject", label: `${r.parent.label} ${short(r.parent.key)}`, detail: r.parent.key });
    rels.push({ id: `${r.subject.id}->part_of`, from: r.subject.id, to: r.parent.id, type: "PART_OF" });
  }
  for (const c of r.parts) {
    nodes.push({ id: c.id, kind: "subject", label: `${c.label} ${short(c.key)}`, detail: c.key });
    rels.push({ id: `${c.id}->part_of`, from: c.id, to: r.subject.id, type: "PART_OF" });
  }
  if (r.partCount > r.parts.length) {   // the rest, as one note
    nodes.push({ id: `${r.subject.id}#more`, kind: "subject", label: `+${(r.partCount - r.parts.length).toLocaleString()} more`,
                 detail: `${r.partCount.toLocaleString()} parts in all; showing ${r.parts.length}` });
    rels.push({ id: `${r.subject.id}#more->part_of`, from: `${r.subject.id}#more`, to: r.subject.id, type: "PART_OF" });
  }
  const seen = new Set<string>();
  for (const d of r.decisions) {
    nodes.push({ id: d.id, kind: "decision", label: d.type.split(".").slice(1).join(".").replaceAll("_", " ") || d.type,
                 option: d.option, tone: tone(d.outcomes.map((o) => o.polarity)), outcomes: d.outcomes.map((o) => o.type),
                 detail: `${d.stage.toLowerCase()} by ${d.actor ?? "?"} (${(d.kind ?? "").toLowerCase().replace("_", " ")}) · ${d.at.slice(0, 10)}` +
                         (d.amount != null ? ` · ${d.amount}` : "") + (d.rationale ? ` · reason: ${d.rationale}` : "") });
    rels.push({ id: `${d.id}->about`, from: d.id, to: d.about, type: "ABOUT" });
    for (const o of d.outcomes) {
      if (!seen.has(o.id)) {
        seen.add(o.id);
        nodes.push({ id: o.id, kind: "outcome", label: words(o.type).replace(/^./, (x) => x.toUpperCase()) + (o.value != null ? ` ${o.value}` : ""),
                     tone: (o.polarity as GraphNode["tone"]) ?? null, detail: `${words(o.type)}${o.polarity ? ` · ${o.polarity}` : ""}` });
      }
      rels.push({ id: `${d.id}->${o.id}`, from: d.id, to: o.id, type: "LED_TO" });
    }
  }
  return { nodes, rels };
}

