// check_fraud_patterns (demo spec §17): the identity behind a customer's charge, read from the graph.
// Which card and device paid, which other accounts share them and how those accounts' charges ended,
// the cluster they form, and what the fraud tool decided. Facts, not a verdict.
import { DEMO_NOW } from "./customer";
import { isType } from "./eventFields";
import { fraudPolicyTree, query, baseScenario } from "./neo4j";

type Flags = { accounts: number; unauthorized_disputes: number; any_dispute: number; fraud_declines: number };
type Other = { name: string; scenario: string; unauthorized: boolean; disputed: boolean; declined: boolean };

// Outcome flags for an account `o` (Customer entity), as Cypher expressions.
const FLAGS = `
  EXISTS { (o)<-[:ABOUT]-(:Decision)-[:ABOUT]->(:Dispute {category: 'unauthorized'}) } AS unauthorized,
  EXISTS { (o)<-[:ABOUT]-(:Decision)-[:ABOUT]->(:Dispute) } AS disputed,
  EXISTS { (o)<-[:ABOUT]-(:Decision {decision_type: 'charge.fraud_screen'})-[:CONSIDERED {status: 'CHOSEN'}]->(:Option {option_key: 'decline'}) } AS declined`;

const sum = (others: Other[]): Flags => ({
  accounts: others.length,
  unauthorized_disputes: others.filter((o) => o.unauthorized).length,
  any_dispute: others.filter((o) => o.disputed).length,
  fraud_declines: others.filter((o) => o.declined).length,
});

let baseline: { accounts: number; unauthorized: number } | null = null;
async function historyBaseline() {
  if (!baseline) {
    const [b] = await query<{ accounts: number; unauthorized: number }>(
      `MATCH (o:Customer:Entity {source_system: 'stripe', scenario_id: $base})
       WITH o, EXISTS { (o)<-[:ABOUT]-(:Decision)-[:ABOUT]->(:Dispute {category: 'unauthorized'}) } AS u
       RETURN count(o) AS accounts, sum(CASE WHEN u THEN 1 ELSE 0 END) AS unauthorized`, { base: baseScenario() });
    baseline = b;
  }
  return baseline;
}

export async function checkFraudPatterns(rawEmail: string, chargeId?: string) {
  const email = rawEmail.trim().toLowerCase().replace(/^"|"$/g, "");
  // The charge: the one named, or the customer's latest.
  const [c] = await query<{ customer: string; scenario: string; name: string; charge: string | null }>(
    `MATCH (c:Customer:Entity {source_system: 'stripe', email: $email})
     OPTIONAL MATCH (ch:Event {stripe_customer_id: c.source_key})
       WHERE ${isType("ch", "charge.succeeded")} AND ch.occurred_at <= datetime($now)
     WITH c, ch ORDER BY ch.occurred_at DESC
     RETURN c.entity_id AS customer, c.scenario_id AS scenario, c.name AS name, coalesce($charge, collect(ch.charge_id)[0]) AS charge`,
    { email, now: DEMO_NOW.toISOString(), charge: chargeId ?? null },
  );
  if (!c) return null;

  const [s] = await query<{
    card: string | null; card_country: string | null; device: string | null; ip_country: string | null;
    risk: number | null; card_age: number | null; country_match: boolean | null; renewal: boolean | null;
    decision: string | null; policy_option: string | null; policy_branch: string | null;
  }>(
    `MATCH (ch:Charge:Entity {source_system: 'stripe', source_key: $charge, scenario_id: $scenario})
     OPTIONAL MATCH (ch)-[:PAID_WITH]->(card:Card)
     OPTIONAL MATCH (ch)-[fd:FROM_DEVICE]->(dev:Device)
     OPTIONAL MATCH (d:Decision {decision_type: 'charge.fraud_screen'})-[:ABOUT]->(ch)
     OPTIONAL MATCH (d)-[:HAD_CONTEXT]->(x:Context)
     OPTIONAL MATCH (d)-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
     OPTIONAL MATCH (d)-[:AT_POINT]->(p:DecisionPoint {tree_id: $policyTree})
     RETURN card.source_key AS card, card.country AS card_country, dev.source_key AS device, fd.ip_country AS ip_country,
            x.\`charge.risk_score\` AS risk, x.\`charge.card_age_days\` AS card_age, x.\`charge.country_match\` AS country_match,
            x.\`charge.is_renewal\` AS renewal, o.option_key AS decision, p.policy_option AS policy_option,
            p.path_label AS policy_branch LIMIT 1`,
    { charge: c.charge, scenario: c.scenario, policyTree: fraudPolicyTree() },
  );

  // Every card and device this account used, and the other accounts on the same ones (in any scenario:
  // the same fingerprint or device ID elsewhere is linked by SAME_AS).
  const shared = await query<{ kind: string; key: string; first_seen: string; others: Other[] }>(
    `MATCH (c:Customer:Entity {entity_id: $customer})-[u:USED]->(x)
     OPTIONAL MATCH (x)-[:SAME_AS*0..2]-(x2)<-[:USED]-(o:Customer {source_system: 'stripe'}) WHERE o <> c
     WITH x, u, o, ${FLAGS}
     WITH x, u, collect(DISTINCT CASE WHEN o IS NULL THEN null ELSE
            {name: o.name, scenario: o.scenario_id, unauthorized: unauthorized, disputed: disputed, declined: declined} END) AS others
     RETURN CASE WHEN x:Card THEN 'card' ELSE 'device' END AS kind, x.source_key AS key,
            toString(date(u.first_seen)) AS first_seen, others
     ORDER BY kind, first_seen`,
    { customer: c.customer },
  );

  // The cluster: accounts reachable through shared cards and devices (up to three accounts away).
  const cluster = await query<Other>(
    `MATCH (c:Customer:Entity {entity_id: $customer})-[:USED|SAME_AS*1..6]-(o:Customer {source_system: 'stripe'})
     WHERE o <> c
     WITH DISTINCT o
     RETURN o.name AS name, o.scenario_id AS scenario, ${FLAGS}
     LIMIT 100`,
    { customer: c.customer },
  );
  const base = await historyBaseline();

  const cards = shared.filter((x) => x.kind === "card"), devices = shared.filter((x) => x.kind === "device");
  const thisCard = cards.find((x) => x.key === s?.card), thisDevice = devices.find((x) => x.key === s?.device);
  const clusterFlags = sum(cluster);
  const baseRate = base.accounts ? base.unauthorized / base.accounts : 0;

  // Plain statements of what the graph shows (no verdict).
  const facts: string[] = [];
  if (s?.card_age != null) {
    facts.push(s.card_age <= 10
      ? `The card was added ${s.card_age} day(s) before this ${s.renewal ? "renewal" : "charge"}.`
      : `The card had been on file ${s.card_age} days.`);
  }
  if (s?.card_country && s?.ip_country) {
    facts.push(s.card_country === s.ip_country ? `Card country and login country match (${s.card_country}).`
      : `Card country ${s.card_country}, but the login came from ${s.ip_country}.`);
  }
  for (const [label, x] of [["card", thisCard], ["device", thisDevice]] as const) {
    if (!x) continue;
    const f = sum(x.others);
    facts.push(f.accounts === 0 ? `This ${label} is used by no other account.`
      : `This ${label} is also used by ${f.accounts} other account(s): ${f.unauthorized_disputes} with unauthorized-charge ` +
        `disputes, ${f.fraud_declines} with fraud declines, ${f.any_dispute} with any dispute.`);
  }
  if (cards.length > 1) facts.push(`This account has used ${cards.length} different cards.`);
  facts.push(clusterFlags.accounts === 0 ? "The account shares no card or device with any other account."
    : `Connected through shared cards/devices to ${clusterFlags.accounts} account(s); ${clusterFlags.unauthorized_disputes} ` +
      `had unauthorized-charge disputes (history baseline: ${(baseRate * 100).toFixed(1)}% of accounts).`);
  if (s?.decision) {
    facts.push(`FraudGuard ${s.decision === "approve" ? "approved" : s.decision === "decline" ? "declined" : "sent to review"} ` +
      `the charge at risk score ${s.risk}` + (s.policy_option && s.policy_option !== s.decision
        ? `; the written policy says "${s.policy_option}" for this case (${s.policy_branch}).` : "."));
  }

  return {
    customer: c.name, charge_id: c.charge,
    charge: s ? { card: s.card, card_country: s.card_country, card_age_days: s.card_age, device: s.device,
                  login_country: s.ip_country, risk_score: s.risk, fraud_tool_decision: s.decision,
                  policy_says: s.policy_option } : null,
    identifiers: shared.map((x) => ({ kind: x.kind, id: x.key, first_seen: x.first_seen, shared_with: sum(x.others),
                                      examples: x.others.slice(0, 5) })),
    cluster: { ...clusterFlags, examples: cluster.slice(0, 8) },
    history_baseline: { accounts: base.accounts, unauthorized_dispute_rate: Math.round(baseRate * 10000) / 10000 },
    facts,
    note: "Usage shows an account was used, not who authorized the charge; for 'I never signed up' claims, identity is the evidence.",
  };
}
