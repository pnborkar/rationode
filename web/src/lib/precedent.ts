// Port of pipeline/src/rationode/analytics/precedent.py (check_before_act).
import liveEmbeddings from "../data/live-embeddings.json";
import { checkUsage } from "./customer";
import { contextText, encode, type Context } from "./features";
import { LIVE } from "./live";
import { IS_DEMO, query, SCENARIO } from "./neo4j";

const COST_OUTCOMES = ["refund_cost", "dispute_won", "dispute_lost"];
const EMBEDDINGS = liveEmbeddings as Record<string, number[]>;

type Candidate = { id: string; text_score: number | null; features: number[]; ctx: Context };

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function holds(x: Context, attribute: string, operator: string, value: unknown): boolean {
  const v = x[attribute];
  if (v === null || v === undefined) return false;
  switch (operator) {
    case ">=": return (v as number) >= (value as number);
    case ">": return (v as number) > (value as number);
    case "<": return (v as number) < (value as number);
    case "<=": return (v as number) <= (value as number);
    case "=": return v === value;
    case "!=": return v !== value;
    case "IN": return (value as unknown[]).includes(v);
    case "NOT IN": return !(value as unknown[]).includes(v);
    default: return false;
  }
}

type TreePoint = {
  tree_id: string; root: string; id: string; leaf: boolean; path_label: string; support: number;
  dispute_rate: number | null; win_rate: number | null; churn_rate: number | null; cost: number | null;
  branches: ({ to: string; attribute: string; operator: string; value: unknown } | null)[];
};

export async function route(decisionType: string, kind: string, x: Context) {
  const rows = await query<TreePoint>(
    `MATCH (t:DecisionTree {decision_type: $type, kind: $kind, scope: 'ALL', scenario_id: $scenario})-[:ROOT]->(root)
     MATCH (p:DecisionPoint {tree_id: t.tree_id})
     OPTIONAL MATCH (p)-[b:BRANCH]->(child:DecisionPoint)
     RETURN t.tree_id AS tree_id, root.point_id AS root, p.point_id AS id, p.is_leaf AS leaf,
            p.path_label AS path_label, p.support AS support, p.rate_dispute_filed AS dispute_rate,
            p.rate_dispute_won AS win_rate, p.rate_churn AS churn_rate, p.cost_per_decision AS cost,
            collect(CASE WHEN child IS NULL THEN null ELSE {to: child.point_id, attribute: b.attribute,
                    operator: b.operator, value: b.value} END) AS branches`,
    { type: decisionType, kind, scenario: SCENARIO },
  );
  if (!rows.length) return null;
  const points = new Map(rows.map((r) => [r.id, r]));
  let node = points.get(rows[0].root)!;
  while (!node.leaf) {
    const next = node.branches.find((b) => b && holds(x, b.attribute, b.operator, b.value));
    if (!next) break;
    node = points.get(next.to)!;
  }
  return {
    tree_id: node.tree_id, point_id: node.id, branch: node.path_label, support: node.support,
    dispute_rate: node.dispute_rate, win_rate: node.win_rate, churn_rate: node.churn_rate,
    cost_per_decision: node.cost,
  };
}

const WHAT_IF: Record<string, Context[]> = {
  "support.complaint_resolution": ["full_refund", "partial_refund", "voucher", "deny"].map((o) => ({ "chosen.option": o })),
  "dispute.evidence": [
    { "chosen.usage_logs": true, "chosen.tos_acceptance": true },
    { "chosen.usage_logs": false, "chosen.tos_acceptance": true },
  ],
};

export async function whatIf(decisionType: string, ctx: Context) {
  const out = [];
  for (const action of WHAT_IF[decisionType] ?? []) {
    const leaf = await route(decisionType, "OUTCOME", { ...ctx, ...action });
    if (leaf) {
      const name = (action["chosen.option"] as string) ??
        (action["chosen.usage_logs"] ? "with usage logs" : "without usage logs");
      out.push({ action: name, ...leaf });
    }
  }
  return out;
}

// Link the customer's viewing to the dispute precedent in the graph: if they kept watching after the charge,
// how do "I canceled" disputes end when usage logs are submitted? If they didn't, how do they end without?
// Gives the expected cost of a dispute if the request is denied.
async function linkUsage(email: string, whatIfs: { action: string; dispute_rate: number | null }[]) {
  const usage = await checkUsage(email);
  if (!usage || !usage.usage_data) return null;
  const watched = usage.hours_since_charge > 0;
  const [p] = await query<{ n: number; won: number }>(
    `MATCH (d:Decision {decision_type: 'dispute.evidence'})-[:HAD_CONTEXT]->(c:Context {\`dispute.category\`: 'subscription_canceled'})
     WHERE (d.scenario_id = $scenario OR ($stories AND d.scenario_id STARTS WITH 'story:'))
       AND c.\`dispute.usage_logs_available\` = $watched
     WITH d, EXISTS { (d)-[:CONSIDERED {status: 'CHOSEN'}]->(:Option {option_key: 'usage_logs'}) } AS sent
     WHERE sent = $watched
     MATCH (d)-[:LED_TO]->(o:Outcome) WHERE o.outcome_type IN ['dispute_won', 'dispute_lost']
     RETURN count(o) AS n, sum(CASE o.outcome_type WHEN 'dispute_won' THEN 1 ELSE 0 END) AS won`,
    { watched, scenario: SCENARIO, stories: IS_DEMO },
  );
  const winRate = p && p.n ? Math.round((p.won / p.n) * 1000) / 1000 : null;
  const deny = whatIfs.find((w) => w.action === "deny");
  const amount = usage.latest_charge.amount_usd;
  const disputeCost = winRate == null ? null : Math.round((winRate * 15 + (1 - winRate) * (amount + 30)) * 100) / 100;
  return {
    applies_to: "'I canceled' / 'I didn't use it' claims. Usage shows the account was used, not who authorized the " +
      "charge, so it is not evidence against 'I never signed up' or 'my card was used without permission'.",
    basis: watched
      ? `kept watching after the charge (${usage.hours_since_charge} h across ${usage.weeks_since_charge} weeks)`
      : "no viewing after the charge",
    dispute_precedent: {
      question: watched
        ? "'I canceled' disputes from customers who kept using the service, contested with usage logs"
        : "'I canceled' disputes from customers with no usage to show",
      disputes: p?.n ?? 0,
      win_rate: winRate,
    },
    if_denied: deny && disputeCost != null ? {
      dispute_rate: deny.dispute_rate,
      cost_if_disputed: disputeCost,
      expected_dispute_cost: Math.round((deny.dispute_rate ?? 0) * disputeCost * 100) / 100,
      assumes: watched ? "usage logs are submitted if a dispute is filed" : "no usage logs can be submitted",
    } : null,
  };
}

export async function checkBeforeAct(decisionType: string, context: Context, k = 150, customerEmail?: string) {
  const text = contextText(decisionType, context);
  const vector = EMBEDDINGS[text];
  const features = await encode(decisionType, context);

  // Candidates: vector search when this case has a precomputed embedding, otherwise every
  // decision of the type ranked by feature similarity (both run inside Neo4j).
  const candidates = vector
    ? await query<Candidate>(
        `CALL db.index.vector.queryNodes('context_embedding_v1', 1500, $vector) YIELD node AS c, score
         MATCH (d:Decision {decision_type: $type, stage: 'FINAL', scenario_id: $scenario})-[:HAD_CONTEXT]->(c)
         RETURN d.decision_id AS id, score AS text_score, c.features AS features, properties(c) AS ctx`,
        { vector, type: decisionType, scenario: SCENARIO },
      )
    : await query<Candidate>(
        `MATCH (d:Decision {decision_type: $type, stage: 'FINAL', scenario_id: $scenario})-[:HAD_CONTEXT]->(c:Context)
         RETURN d.decision_id AS id, null AS text_score, c.features AS features, properties(c) AS ctx`,
        { type: decisionType, scenario: SCENARIO },
      );
  // Decisions from loaded Events-tab sets are evidence too (they have features but no embedding); demo only.
  if (IS_DEMO) candidates.push(...await query<Candidate>(
    `MATCH (d:Decision {decision_type: $type, stage: 'FINAL'})-[:HAD_CONTEXT]->(c:Context)
     WHERE d.scenario_id STARTS WITH 'story:'
     RETURN d.decision_id AS id, null AS text_score, c.features AS features, properties(c) AS ctx`,
    { type: decisionType },
  ));
  // Live decisions count once their outcome window has closed ("60 days later", §19.3), with or without outcome
  // events ("no dispute, no churn" is an outcome too). Before that, a decision whose outcome isn't known yet
  // would read as "nothing bad happened" and bias every rate.
  candidates.push(...await query<Candidate>(
    `MATCH (d:Decision {decision_type: $type, stage: 'FINAL', scenario_id: $live})-[:HAD_CONTEXT]->(c:Context)
     WHERE d.outcome_window_closed_at IS NOT NULL
     RETURN d.decision_id AS id, null AS text_score, c.features AS features, properties(c) AS ctx`,
    { type: decisionType, live: LIVE },
  ));
  const scored = candidates
    .map((c) => {
      const feature = cosine(features, c.features ?? []);
      // Decisions not in the vector index (live, sets) get their text similarity from the embedding of their
      // context text when there is one (0.9 otherwise), so an exact match isn't ranked below history by default.
      const own = vector && c.text_score == null ? EMBEDDINGS[contextText(decisionType, c.ctx)] : undefined;
      const text = c.text_score ?? (own ? cosine(vector!, own) : 0.9);
      return { ...c, score: vector ? 0.3 * text + 0.7 * feature : feature };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const details = await query<{ id: string; options: string[]; outcomes: string[]; cost: number }>(
    `UNWIND $ids AS id
     MATCH (d:Decision {decision_id: id})
     OPTIONAL MATCH (d)-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
     WITH d, collect(o.option_key) AS options
     OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome)
     RETURN d.decision_id AS id, options, collect(out.outcome_type) AS outcomes,
            sum(CASE WHEN out.outcome_type IN $cost THEN out.value_usd ELSE 0 END) AS cost`,
    { ids: scored.map((c) => c.id), cost: COST_OUTCOMES },
  );

  const byOption = new Map<string, typeof details>();
  for (const d of details) {
    const label = decisionType === "dispute.evidence"
      ? (d.options.includes("usage_logs") ? "usage_logs" : "no_usage_logs")
      : (d.options[0] ?? "unknown");
    byOption.set(label, [...(byOption.get(label) ?? []), d]);
  }
  const rate = (rows: typeof details, t: string) =>
    Math.round((rows.filter((r) => r.outcomes.includes(t)).length / rows.length) * 1000) / 1000;
  const options = [...byOption.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([option, rows]) => ({
      option, n: rows.length, share: Math.round((rows.length / details.length) * 1000) / 1000,
      dispute_rate: rate(rows, "dispute_filed"), churn_rate: rate(rows, "churn"), win_rate: rate(rows, "dispute_won"),
      avg_cost: Math.round((rows.reduce((s, r) => s + r.cost, 0) / rows.length) * 100) / 100,
    }));

  const whatIfs = await whatIf(decisionType, context);
  return {
    decision_type: decisionType,
    case: text,
    similar_decisions: scored.length,
    search: vector ? "vector search + feature similarity" : "feature similarity",
    note:
      "options: what was chosen among the nearest past decisions, and what followed (per-option samples can be small). " +
      "what_if: outcome rates from the learned outcome tree for the branch this case would fall into under each action " +
      "(support = number of past decisions in that branch).",
    options,
    // The closest past decisions with what was chosen and what followed (drawn in the graph panel).
    neighbours: scored.slice(0, 16).map((c) => {
      const d = details.find((x) => x.id === c.id);
      return { decision_id: c.id, score: Math.round(c.score * 1000) / 1000, option: d?.options[0] ?? null,
               outcomes: d?.outcomes ?? [], cost: d?.cost ?? 0 };
    }),
    // Recent live decisions among the similar ones, once their outcome window closed ("60 days later"): listed on
    // their own because they have no precomputed text embedding, so they rank below equally similar history
    // decisions and would rarely reach the top 16. They count in `options` either way.
    recent_live: scored.filter((c) => c.id.startsWith(`${LIVE}|`)).slice(0, 5).map((c) => {
      const d = details.find((x) => x.id === c.id);
      return { decision_id: c.id, score: Math.round(c.score * 1000) / 1000, rank: scored.indexOf(c) + 1,
               option: d?.options[0] ?? null, outcomes: d?.outcomes ?? [], cost: d?.cost ?? 0,
               context: contextText(decisionType, c.ctx) };
    }),
    examples: scored.slice(0, 3).map((c) => ({
      decision_id: c.id, score: Math.round(c.score * 1000) / 1000, context: contextText(decisionType, c.ctx),
    })),
    what_if: whatIfs,
    usage_link: customerEmail && decisionType === "support.complaint_resolution"
      ? await linkUsage(customerEmail, whatIfs) : null,
  };
}
