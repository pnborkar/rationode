"""The demo's three reveals as Cypher (demo spec Section 9, steps 3, 4, 6)."""

REVEALS = {
    "reveal1_policy_vs_reality": {
        "title": "Reveal 1 — Policy vs reality: disputes (policy: contest over $50, accept $50 or less)",
        "cypher": """
MATCH (:Policy {policy_id: 'streamly-disputes'})-[:DEFINES]->(t:DecisionTree {scenario_id: $scenario, decision_type: 'dispute.response'})
MATCH (t)-[:ROOT]->(:DecisionPoint)-[:BRANCH*0..6]->(leaf:DecisionPoint {is_leaf: true})
MATCH (leaf)-[f:BRANCH]->(actual:Option)
RETURN leaf.path_label AS policy_branch, leaf.policy_option AS policy_says, leaf.support AS disputes,
       actual.option_key AS actually_did, f.share AS share, f.cost_per_decision AS avg_cost
ORDER BY policy_branch, share DESC
""",
    },
    "reveal1b_by_agent_version": {
        "title": "Reveal 1b — Small disputes (≤ $50): how often each AI version contests",
        "cypher": """
MATCH (t:DecisionTree {scenario_id: $scenario, decision_type: 'dispute.response', kind: 'POLICY'})
MATCH (t)-[:ROOT]->(:DecisionPoint)-[:BRANCH*0..6]->(leaf:DecisionPoint {is_leaf: true, policy_option: 'accept'})
MATCH (d:Decision)-[:AT_POINT]->(leaf), (d)-[:MADE_BY]->(a:Actor)
WITH a.version AS agent, count(d) AS disputes,
     sum(CASE WHEN EXISTS { (d)-[:CONSIDERED {status: 'CHOSEN'}]->(:Option {option_key: 'contest'}) } THEN 1 ELSE 0 END) AS contested
RETURN agent, disputes, contested, round(100.0 * contested / disputes, 1) AS contest_pct
ORDER BY agent
""",
    },
    "reveal2_ai_vs_human": {
        "title": "Reveal 2 — AI vs human: AI proposed deny; what humans did, by tenure, and what followed",
        "cypher": """
MATCH (f:Decision {decision_type: 'support.complaint_resolution', stage: 'FINAL', scenario_id: $scenario})
      -[:MADE_BY]->(:Actor {kind: 'HUMAN'})
MATCH (f)-[:PRECEDED_BY]->(:Decision {stage: 'PROPOSAL'})-[:CONSIDERED {status: 'PROPOSED'}]->(:Option {option_key: 'deny'})
MATCH (f)-[:HAD_CONTEXT]->(c:Context)
WITH f, c.`support.tenure_months` >= 24 AS long_tenure,
     EXISTS { (f)-[:OVERRIDES]->() } AS human_overrode,
     EXISTS { (f)-[:LED_TO]->(:Outcome {outcome_type: 'dispute_filed'}) } AS disputed,
     EXISTS { (f)-[:LED_TO]->(:Outcome {outcome_type: 'churn'}) } AS churned
RETURN long_tenure, human_overrode, count(f) AS decisions,
       round(100.0 * sum(CASE WHEN disputed THEN 1 ELSE 0 END) / count(f), 1) AS dispute_pct,
       round(100.0 * sum(CASE WHEN churned THEN 1 ELSE 0 END) / count(f), 1) AS churn_pct
ORDER BY long_tenure DESC, human_overrode DESC
""",
    },
    "reveal2b_prompt_drift": {
        "title": "Reveal 2b — Prompt drift: AI deny rate by version",
        "cypher": """
MATCH (p:Decision {decision_type: 'support.complaint_resolution', stage: 'PROPOSAL', scenario_id: $scenario})-[:MADE_BY]->(a:Actor)
WITH a.version AS agent, count(p) AS proposals,
     sum(CASE WHEN EXISTS { (p)-[:CONSIDERED {status: 'PROPOSED'}]->(:Option {option_key: 'deny'}) } THEN 1 ELSE 0 END) AS denies
RETURN agent, proposals, round(100.0 * denies / proposals, 1) AS deny_pct
ORDER BY agent
""",
    },
    "reveal3_hidden_cost": {
        "title": "Reveal 3 — Hidden cost: the evidence outcome tree's leaves, costliest first",
        "cypher": """
MATCH (t:DecisionTree {scenario_id: $scenario, decision_type: 'dispute.evidence', kind: 'OUTCOME'})-[:ROOT]->(root)
MATCH (root)-[:BRANCH*0..6]->(leaf:DecisionPoint {is_leaf: true})
RETURN leaf.path_label AS branch, leaf.support AS disputes, round(100 * leaf.rate_dispute_won, 1) AS win_pct,
       leaf.cost_per_decision AS avg_cost, round(leaf.support * leaf.cost_per_decision) AS total_cost
ORDER BY total_cost DESC
""",
    },
    "reveal3b_five_lines": {
        "title": "Reveal 3b — The five-line version, straight from decisions",
        "cypher": """
MATCH (d:Decision {decision_type: 'dispute.evidence', scenario_id: $scenario})-[:HAD_CONTEXT]->(:Context {`dispute.category`: 'subscription_canceled'})
MATCH (d)-[:LED_TO]->(o:Outcome) WHERE o.outcome_type IN ['dispute_won', 'dispute_lost']
WITH EXISTS { (d)-[:CONSIDERED {status: 'CHOSEN'}]->(:Option {option_key: 'usage_logs'}) } AS usage_logs, o
RETURN usage_logs, count(o) AS disputes, round(100.0 * sum(CASE o.outcome_type WHEN 'dispute_won' THEN 1 ELSE 0 END) / count(o), 1) AS win_pct,
       round(sum(o.value_usd)) AS total_cost
""",
    },
}
