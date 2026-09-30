import neo4j from "neo4j-driver";
import { liveScenario } from "./live";
import { demoMode, query, baseScenario } from "./neo4j";

// find_precedent(query): free-text search over decision contexts (Neo4j full-text index),
// returning final decisions with what was chosen and what followed.
export async function findPrecedent(text: string, decisionType?: string, limit = 10) {
  // Lucene syntax: quote each term so user input can't break the query.
  const terms = text.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/["\\]/g, "")}"`).join(" ");
  if (!terms) return [];
  return query(
    `CALL db.index.fulltext.queryNodes('context_text', $terms) YIELD node AS c, score
     MATCH (d:Decision {stage: 'FINAL'})-[:HAD_CONTEXT]->(c)
     WHERE (d.scenario_id = $scenario OR ($stories AND d.scenario_id STARTS WITH 'story:')
            OR (d.scenario_id = $live AND d.outcome_window_closed_at IS NOT NULL))   // live, once its outcome window closed
       AND ($type IS NULL OR d.decision_type = $type)
     WITH d, c, score ORDER BY score DESC LIMIT $limit
     MATCH (d)-[:MADE_BY]->(a:Actor)
     OPTIONAL MATCH (d)-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
     WITH d, c, score, a, collect(o.option_key) AS options
     OPTIONAL MATCH (d)-[:LED_TO]->(out:Outcome)
     RETURN d.decision_id AS decision_id, d.decision_type AS decision_type, round(score, 3) AS score,
            c.summary_text AS summary, a.kind AS actor_kind, options, collect(DISTINCT out.outcome_type) AS outcomes
     ORDER BY score DESC`,
    { terms, scenario: baseScenario(), stories: demoMode(), live: liveScenario(), type: decisionType ?? null, limit: neo4j.int(Math.min(Math.max(Math.trunc(limit), 1), 50)) },
  );
}
