// Port of pipeline/src/rationode/analytics/precedent.py (check_before_act).
import liveEmbeddings from "../data/live-embeddings.json";
import { contextText, encode, type Context } from "./features";
import { query, SCENARIO } from "./neo4j";

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

export async function checkBeforeAct(decisionType: string, context: Context, k = 150) {
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
  const scored = candidates
    .map((c) => {
      const feature = cosine(features, c.features ?? []);
      return { ...c, score: vector ? 0.3 * (c.text_score ?? 0.9) + 0.7 * feature : feature };
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

  return {
    decision_type: decisionType,
    case: text,
    similar_decisions: scored.length,
    search: vector ? "vector search + feature similarity" : "feature similarity",
    options,
    examples: scored.slice(0, 3).map((c) => ({
      decision_id: c.id, score: Math.round(c.score * 1000) / 1000, context: contextText(decisionType, c.ctx),
    })),
    what_if: await whatIf(decisionType, context),
  };
}
