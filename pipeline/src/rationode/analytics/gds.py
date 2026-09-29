"""Graph Data Science on the decision graph, via the GDS plugin (plain Cypher).

    kNN      similar decisions (encoded context), written as SIMILAR_TO {score}
    Leiden   clusters over the kNN graph, written as Decision.cluster_id
    Peers    human reps grouped by how they decide (kNN + Leiden over rep profiles),
             written as Actor.peer_group; the group that deviates is reported

Feature vectors are computed from the schema registry encodings and stored on
Context.features (and Actor.profile), so the same projections can run live
from the app with Cypher alone.
"""

import time
from collections.abc import Callable

from neo4j import Driver

from rationode.analytics.features import Encoder

TOP_K = 10
SEED = 42
KNN_TYPES = [("support.complaint_resolution", "FINAL"), ("dispute.response", "FINAL"), ("dispute.evidence", "FINAL")]

Q_ALL_CONTEXTS = """
MATCH (d:Decision {scenario_id: $scenario})-[:HAD_CONTEXT]->(c:Context)
RETURN c.context_id AS id, d.decision_type AS type, properties(c) AS ctx
"""
Q_WRITE_FEATURES = """
UNWIND $rows AS r
MATCH (c:Context {context_id: r.id}) SET c.features = r.features
"""
Q_DROP = "CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName"

# Decisions of one type as nodes carrying their context features
Q_PROJECT_DECISIONS = """
MATCH (d:Decision {decision_type: $type, stage: $stage, scenario_id: $scenario})-[:HAD_CONTEXT]->(c:Context)
WITH gds.graph.project($g, d, null, {sourceNodeProperties: {features: c.features}, targetNodeProperties: null}) AS g
RETURN g.nodeCount AS nodes
"""
Q_KNN_MUTATE = """
CALL gds.knn.mutate($g, {nodeProperties: [$prop], topK: $k, randomSeed: $seed, concurrency: 1,
                        sampleRate: 1.0, deltaThreshold: 0.0,
                        mutateRelationshipType: 'SIMILAR', mutateProperty: 'score'})
YIELD relationshipsWritten RETURN relationshipsWritten
"""
Q_UNDIRECTED = """
CALL gds.graph.relationships.toUndirected($g, {relationshipType: 'SIMILAR', mutateRelationshipType: 'SIMILAR_U'})
YIELD relationshipsWritten RETURN relationshipsWritten
"""
Q_LEIDEN = """
CALL gds.leiden.stream($g, {relationshipTypes: ['SIMILAR_U'], relationshipWeightProperty: 'score',
                            randomSeed: $seed, concurrency: 1})
YIELD nodeId, communityId
RETURN gds.util.asNode(nodeId) AS n, communityId
"""
Q_CLEAR_SIMILAR = """
MATCH (d:Decision {decision_type: $type, stage: $stage, scenario_id: $scenario})-[s:SIMILAR_TO]->()
DELETE s
"""
Q_WRITE_SIMILAR = """
CALL gds.graph.relationshipProperty.stream($g, 'score', ['SIMILAR'])
YIELD sourceNodeId, targetNodeId, propertyValue
WITH gds.util.asNode(sourceNodeId) AS a, gds.util.asNode(targetNodeId) AS b, propertyValue AS score
MERGE (a)-[s:SIMILAR_TO]->(b) SET s.score = round(score, 4), s.algorithm = 'gds.knn', s.k = $k
RETURN count(s) AS written
"""
Q_WRITE_CLUSTERS = """
CALL gds.leiden.stream($g, {relationshipTypes: ['SIMILAR_U'], relationshipWeightProperty: 'score',
                            randomSeed: $seed, concurrency: 1})
YIELD nodeId, communityId
WITH gds.util.asNode(nodeId) AS d, communityId
SET d.cluster_id = $type + ':' + communityId
RETURN count(DISTINCT communityId) AS clusters
"""

Q_REP_PROFILES = """
MATCH (a:Actor {kind: 'HUMAN', scenario_id: $scenario})<-[:MADE_BY]-(f:Decision {decision_type: 'support.complaint_resolution', stage: 'FINAL'})
MATCH (f)-[:HAD_CONTEXT]->(c:Context)
MATCH (f)-[:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
OPTIONAL MATCH (f)-[:PRECEDED_BY]->(:Decision {stage: 'PROPOSAL'})-[:CONSIDERED {status: 'PROPOSED'}]->(po:Option)
WITH a, o.option_key AS chosen, po.option_key AS proposed, c.`support.tenure_months` >= 24 AS long_tenure
WITH a, count(*) AS n,
     sum(CASE WHEN chosen = 'full_refund' THEN 1 ELSE 0 END) AS refunds,
     sum(CASE WHEN chosen = 'deny' THEN 1 ELSE 0 END) AS denies,
     sum(CASE WHEN proposed = 'deny' AND NOT long_tenure THEN 1 ELSE 0 END) AS ai_deny_short,
     sum(CASE WHEN proposed = 'deny' AND NOT long_tenure AND chosen <> 'deny' THEN 1 ELSE 0 END) AS over_short,
     sum(CASE WHEN proposed = 'deny' AND long_tenure THEN 1 ELSE 0 END) AS ai_deny_long,
     sum(CASE WHEN proposed = 'deny' AND long_tenure AND chosen <> 'deny' THEN 1 ELSE 0 END) AS over_long
WITH a, toFloat(over_short) / CASE ai_deny_short WHEN 0 THEN 1 ELSE ai_deny_short END AS override_short,
     toFloat(over_long) / CASE ai_deny_long WHEN 0 THEN 1 ELSE ai_deny_long END AS override_long,
     toFloat(refunds) / n AS full_refund_share, toFloat(denies) / n AS deny_share
SET a.override_short = override_short, a.override_long = override_long,
    a.full_refund_share = full_refund_share, a.deny_share = deny_share,
    a.profile = [override_short, override_long, full_refund_share, deny_share]
RETURN count(a) AS reps
"""
Q_PROJECT_REPS = """
MATCH (a:Actor {kind: 'HUMAN', scenario_id: $scenario}) WHERE a.profile IS NOT NULL
WITH gds.graph.project($g, a, null, {sourceNodeProperties: {profile: a.profile}, targetNodeProperties: null}) AS g
RETURN g.nodeCount AS nodes
"""
Q_WRITE_PEERS = """
CALL gds.leiden.stream($g, {relationshipTypes: ['SIMILAR_U'], relationshipWeightProperty: 'score',
                            randomSeed: $seed, concurrency: 1})
YIELD nodeId, communityId
WITH gds.util.asNode(nodeId) AS a, communityId
SET a.peer_group = communityId
WITH a
MATCH (all:Actor {kind: 'HUMAN', scenario_id: $scenario}) WHERE all.profile IS NOT NULL
WITH a, avg(all.override_short) AS overall
SET a.peer_deviation = round(a.override_short - overall, 4)
RETURN count(a) AS reps
"""
Q_PEER_SUMMARY = """
MATCH (a:Actor {kind: 'HUMAN', scenario_id: $scenario}) WHERE a.peer_group IS NOT NULL
RETURN a.peer_group AS group, count(a) AS reps, avg(a.override_short) AS override_short,
       avg(a.override_long) AS override_long, collect(DISTINCT a.team) AS teams,
       [t IN collect(a.team) | t] AS team_list
ORDER BY override_short DESC
"""


def q(driver: Driver, db: str, query: str, **params):
    return driver.execute_query(query, database_=db, **params).records


def write_features(driver: Driver, db: str, encoder: Encoder, scenario: str) -> int:
    rows = q(driver, db, Q_ALL_CONTEXTS, scenario=scenario)
    # The attribute scales live on the shared schema registry: only the base history fits them, so another
    # tenant's run can't change how the demo's contexts are encoded (a real multi-tenant install would keep
    # scales per tenant).
    if scenario == "history":
        encoder.fit_scales(driver, db, [r["ctx"] for r in rows])
    batch = [{"id": r["id"], "features": encoder.vector(r["type"], r["ctx"])} for r in rows]
    for i in range(0, len(batch), 5000):
        q(driver, db, Q_WRITE_FEATURES, rows=batch[i:i + 5000])
    return len(batch)


def run(driver: Driver, db: str, scenario: str = "history", log: Callable[[str], None] = print) -> None:
    start = time.time()
    n = write_features(driver, db, Encoder(driver, db), scenario)
    log(f"  context features written for {n} decisions in {time.time() - start:.0f}s")

    for decision_type, stage in KNN_TYPES:
        t0 = time.time()
        g = f"rn_{scenario}_{decision_type.replace('.', '_')}"
        q(driver, db, Q_DROP, g=g)
        nodes = q(driver, db, Q_PROJECT_DECISIONS, g=g, type=decision_type, stage=stage, scenario=scenario)[0]["nodes"]
        q(driver, db, Q_KNN_MUTATE, g=g, prop="features", k=TOP_K, seed=SEED)
        q(driver, db, Q_UNDIRECTED, g=g)
        q(driver, db, Q_CLEAR_SIMILAR, type=decision_type, stage=stage, scenario=scenario)
        written = q(driver, db, Q_WRITE_SIMILAR, g=g, k=TOP_K)[0]["written"]
        clusters = q(driver, db, Q_WRITE_CLUSTERS, g=g, type=decision_type, seed=SEED)[0]["clusters"]
        q(driver, db, Q_DROP, g=g)
        log(f"  {decision_type:<30} {nodes:>6} decisions  {written:>6} SIMILAR_TO  {clusters:>3} clusters  "
            f"{time.time() - t0:.0f}s")

    # Peer groups of human reps: who decides differently from their peers?
    g = f"rn_{scenario}_reps"
    reps = q(driver, db, Q_REP_PROFILES, scenario=scenario)[0]["reps"]
    q(driver, db, Q_DROP, g=g)
    q(driver, db, Q_PROJECT_REPS, g=g, scenario=scenario)
    q(driver, db, Q_KNN_MUTATE, g=g, prop="profile", k=5, seed=SEED)
    q(driver, db, Q_UNDIRECTED, g=g)
    q(driver, db, Q_WRITE_PEERS, g=g, seed=SEED, scenario=scenario)
    q(driver, db, Q_DROP, g=g)
    log(f"  reps: {reps} grouped by how they decide")
    for r in q(driver, db, Q_PEER_SUMMARY, scenario=scenario):
        teams = {t: r["team_list"].count(t) for t in sorted(set(r["team_list"]))}
        log(f"    peer group {r['group']}: {r['reps']:>2} reps  override AI deny (short tenure) {r['override_short']:5.0%}  "
            f"(long tenure) {r['override_long']:5.0%}   teams, for verification only: {teams}")
    log(f"  done in {time.time() - start:.0f}s")
