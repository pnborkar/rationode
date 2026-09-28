import { query, SCENARIO } from "./neo4j";

// why(decision_id): the decision, the chain it sits in, what it led to, where it falls in the
// learned trees, and the most similar decisions (GDS kNN).
export async function why(decisionId: string) {
  const [d] = await query(
    `MATCH (d:Decision {decision_id: $id})-[:MADE_BY]->(a:Actor)
     MATCH (d)-[:HAD_CONTEXT]->(c:Context)
     OPTIONAL MATCH (d)-[k:CONSIDERED]->(o:Option) WHERE k.status IN ['CHOSEN', 'PROPOSED', 'REJECTED']
     WITH d, a, c, collect({option: o.option_key, status: k.status, amount_usd: k.amount_usd}) AS options
     OPTIONAL MATCH (d)-[l:LED_TO]->(out:Outcome)
     WITH d, a, c, options, collect({outcome: out.outcome_type, value_usd: out.value_usd, at: out.occurred_at,
                                     confidence: l.confidence, method: l.attribution_method}) AS outcomes
     OPTIONAL MATCH (d)-[:OVERRIDES]->(p:Decision)-[:CONSIDERED {status: 'PROPOSED'}]->(po:Option)
     RETURN d.decision_id AS decision_id, d.decision_type AS decision_type, d.stage AS stage,
            d.decided_at AS decided_at, a.kind AS actor_kind, a.name AS actor, a.team AS team,
            c.summary_text AS summary, options, [o IN outcomes WHERE o.outcome IS NOT NULL] AS outcomes,
            po.option_key AS overrode_ai_proposal`,
    { id: decisionId },
  );
  if (!d) return null;

  const chain = await query(
    `MATCH (d:Decision {decision_id: $id})
     MATCH (c:Customer:Entity {source_system: 'stripe'})<-[:ABOUT]-(d)
     MATCH (x:Decision)-[:ABOUT]->(c) WHERE x.scenario_id = $scenario OR x.scenario_id STARTS WITH 'story:'
     MATCH (x)-[:MADE_BY]->(a:Actor)
     OPTIONAL MATCH (x)-[k:CONSIDERED]->(o:Option) WHERE k.status IN ['CHOSEN', 'PROPOSED']
     RETURN x.decision_id AS decision_id, x.decision_type AS decision_type, x.stage AS stage,
            x.decided_at AS decided_at, a.name AS actor, collect(o.option_key) AS options
     ORDER BY decided_at`,
    { id: decisionId, scenario: SCENARIO },
  );

  const branches = await query(
    `MATCH (:Decision {decision_id: $id})-[:AT_POINT]->(p:DecisionPoint)
     MATCH (t:DecisionTree {tree_id: p.tree_id})
     RETURN t.title AS tree, t.kind AS kind, p.path_label AS branch, p.support AS decisions,
            p.rate_dispute_filed AS dispute_rate, p.rate_churn AS churn_rate, p.rate_dispute_won AS win_rate,
            p.policy_option AS policy_says
     ORDER BY kind, tree`,
    { id: decisionId },
  );

  const similar = await query(
    `MATCH (:Decision {decision_id: $id})-[s:SIMILAR_TO]->(n:Decision)-[:HAD_CONTEXT]->(c:Context)
     OPTIONAL MATCH (n)-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
     RETURN n.decision_id AS decision_id, s.score AS score, c.summary_text AS summary, collect(o.option_key) AS options
     ORDER BY score DESC LIMIT 5`,
    { id: decisionId },
  );

  return { ...d, case_chain: chain, tree_branches: branches, similar_decisions: similar };
}
