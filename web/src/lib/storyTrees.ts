// Place a loaded scenario's decisions into the existing history trees (AT_POINT) and recompute the
// touched branches' statistics, with the same formulas as pipeline/src/rationode/trees/build.py.
import type { Context } from "./features";
import { query } from "./neo4j";
import { holds } from "./precedent";

const COST = ["refund_cost", "dispute_won", "dispute_lost"];
const OUTCOME_TYPES = ["churn", "dispute_filed", "dispute_lost", "dispute_won", "refund_cost", "renewal"];
const EVIDENCE = ["usage_logs", "tos_acceptance", "cancellation_emails", "delivery_confirmation"];

export type BranchChange = {
  point_id: string; tree: string; kind: string; branch: string;
  before: BranchStats; after: BranchStats;
};
type BranchStats = { support: number; dispute_rate: number | null; churn_rate: number | null;
                     win_rate: number | null; cost_per_decision: number | null };

type ScenarioDecision = { id: string; type: string; stage: string; ctx: Context; options: string[]; outcomes: string[] };
type Point = { id: string; leaf: boolean; branches: ({ to: string; attribute: string; operator: string; value: unknown } | null)[] };

async function branchStats(pointIds: string[]) {
  const rows = await query<BranchStats & { point_id: string; tree: string; kind: string; branch: string }>(
    `UNWIND $ids AS id
     MATCH (p:DecisionPoint {point_id: id}), (t:DecisionTree {tree_id: p.tree_id})
     RETURN p.point_id AS point_id, t.title AS tree, t.kind AS kind, p.path_label AS branch, p.support AS support,
            p.rate_dispute_filed AS dispute_rate, p.rate_churn AS churn_rate, p.rate_dispute_won AS win_rate,
            p.cost_per_decision AS cost_per_decision`,
    { ids: pointIds },
  );
  return new Map(rows.map((r) => [r.point_id, r]));
}

// Recompute a leaf's support, outcome rates, cost, policy compliance, and its fan-out edges from every
// decision currently placed there (history + any loaded scenarios).
async function recompute(pointIds: string[]) {
  if (!pointIds.length) return;
  const rates = OUTCOME_TYPES.map((t) =>
    `p.rate_${t} = round(toFloat(size([x IN rs WHERE '${t}' IN x.types])) / n, 4)`).join(", ");
  const fanRates = OUTCOME_TYPES.map((t) =>
    `b.rate_${t} = CASE WHEN size(grp) = 0 THEN null ELSE round(toFloat(size([x IN grp WHERE '${t}' IN x.types])) / size(grp), 4) END`).join(", ");
  await query(
    `UNWIND $ids AS id
     MATCH (p:DecisionPoint {point_id: id})<-[:AT_POINT]-(d:Decision)
     OPTIONAL MATCH (d)-[k:CONSIDERED]->(opt:Option) WHERE k.status IN ['CHOSEN', 'PROPOSED']
     WITH p, d, collect(DISTINCT opt.option_key) AS options
     OPTIONAL MATCH (d)-[:LED_TO]->(o:Outcome)
     WITH p, d, options, collect(o.outcome_type) AS types,
          sum(CASE WHEN o.outcome_type IN $cost THEN o.value_usd ELSE 0 END) AS cost
     WITH p, collect({options: options, types: types, cost: cost}) AS rs
     WITH p, rs, size(rs) AS n
     SET p.support = n, ${rates},
         p.cost_per_decision = round(reduce(s = 0.0, x IN rs | s + x.cost) / n, 2),
         p.policy_compliance = CASE WHEN p.policy_option IS NULL THEN p.policy_compliance
           ELSE round(toFloat(size([x IN rs WHERE p.policy_option IN x.options])) / n, 4) END
     WITH p, rs, n
     MATCH (p)-[b:BRANCH {leaf: true}]->(fo:Option)
     WITH p, rs, n, b, fo,
          [x IN rs WHERE CASE WHEN p.decision_type = 'dispute.evidence'
                               THEN (fo.option_key IN x.options) = coalesce(b.included, true)
                               ELSE fo.option_key IN x.options END] AS grp
     SET b.support = size(grp), b.share = round(toFloat(size(grp)) / n, 4), ${fanRates},
         b.cost_per_decision = CASE WHEN size(grp) = 0 THEN null
           ELSE round(reduce(s = 0.0, x IN grp | s + x.cost) / size(grp), 2) END`,
    { ids: pointIds, cost: COST },
  );
}

async function loadTree(treeId: string) {
  const rows = await query<Point & { root: string }>(
    `MATCH (t:DecisionTree {tree_id: $id})-[:ROOT]->(root)
     MATCH (p:DecisionPoint {tree_id: $id})
     OPTIONAL MATCH (p)-[b:BRANCH]->(child:DecisionPoint)
     RETURN root.point_id AS root, p.point_id AS id, p.is_leaf AS leaf,
            collect(CASE WHEN child IS NULL THEN null ELSE {to: child.point_id, attribute: b.attribute,
                    operator: b.operator, value: b.value} END) AS branches`,
    { id: treeId },
  );
  return { root: rows[0]?.root, points: new Map(rows.map((r) => [r.id, r])) };
}

function routeLeaf(tree: Awaited<ReturnType<typeof loadTree>>, x: Context): string | null {
  let node = tree.points.get(tree.root);
  while (node && !node.leaf) {
    const next = node.branches.find((b) => b && holds(x, b.attribute, b.operator, b.value));
    if (!next) return null;
    node = tree.points.get(next.to);
  }
  return node?.id ?? null;
}

// Leaves currently holding any of a scenario's decisions (needed before deleting the scenario).
export async function touchedPoints(scenario: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `MATCH (:Decision {scenario_id: $scenario})-[:AT_POINT]->(p:DecisionPoint) RETURN DISTINCT p.point_id AS id`,
    { scenario },
  );
  return rows.map((r) => r.id);
}

export async function recomputePoints(pointIds: string[]) {
  await recompute(pointIds);
}

export async function placeScenario(scenario: string): Promise<BranchChange[]> {
  const decisions = await query<ScenarioDecision>(
    `MATCH (d:Decision {scenario_id: $scenario})-[:HAD_CONTEXT]->(c:Context)
     OPTIONAL MATCH (d)-[k:CONSIDERED]->(o:Option) WHERE k.status IN ['CHOSEN', 'PROPOSED']
     WITH d, c, collect(o.option_key) AS options
     OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome)
     RETURN d.decision_id AS id, d.decision_type AS type, d.stage AS stage, properties(c) AS ctx, options,
            collect(out.outcome_type) AS outcomes`,
    { scenario },
  );
  const approved = new Set((await query<{ key: string }>(
    `MATCH (s:SchemaElement {kind: 'OPTION', status: 'APPROVED'}) RETURN s.key AS key`)).map((r) => r.key));
  const trees = await query<{ tree_id: string; decision_type: string; stage: string; kind: string }>(
    `MATCH (t:DecisionTree {scenario_id: 'history'}) WHERE t.scope IN ['ALL', 'POLICY']
     RETURN t.tree_id AS tree_id, t.decision_type AS decision_type, t.stage AS stage, t.kind AS kind`,
  );

  const placements: { decision_id: string; point_id: string }[] = [];
  for (const t of trees) {
    const candidates = decisions.filter((d) => d.type === t.decision_type && d.stage === t.stage
      // Options still PROPOSED in the registry stay out of trees until approved (as in the tree builder).
      && (d.type === "dispute.evidence" || d.options.every((o) => approved.has(`${d.type}.${o}`)))
      && !(t.kind === "OUTCOME" && d.type === "dispute.evidence"
           && !d.outcomes.some((o) => o === "dispute_won" || o === "dispute_lost")));
    if (!candidates.length) continue;
    const tree = await loadTree(t.tree_id);
    for (const d of candidates) {
      const x: Context = { ...d.ctx, "chosen.option": d.options[0] ?? null };
      for (const e of EVIDENCE) x[`chosen.${e}`] = d.options.includes(e);
      const leaf = routeLeaf(tree, x);
      if (leaf) placements.push({ decision_id: d.id, point_id: leaf });
    }
  }
  const pointIds = [...new Set(placements.map((p) => p.point_id))];
  const before = await branchStats(pointIds);
  if (placements.length) {
    await query(
      `UNWIND $rows AS r
       MATCH (d:Decision {decision_id: r.decision_id}), (p:DecisionPoint {point_id: r.point_id})
       MERGE (d)-[a:AT_POINT]->(p) SET a.assigned_by = 'LIVE_ROUTING', a.confidence = 1.0`,
      { rows: placements },
    );
  }
  await recompute(pointIds);
  const after = await branchStats(pointIds);
  return pointIds.map((id) => {
    const b = before.get(id)!, a = after.get(id)!;
    return { point_id: id, tree: a.tree, kind: a.kind, branch: a.branch, before: b, after: a };
  });
}
