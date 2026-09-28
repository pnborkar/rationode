// Rationode core schema (v4.1 business case, Section 8.4.9; demo spec Section 3)
// Idempotent: safe to run repeatedly.

// Uniqueness constraints
CREATE CONSTRAINT decision_id IF NOT EXISTS FOR (d:Decision) REQUIRE d.decision_id IS UNIQUE;
CREATE CONSTRAINT actor_id IF NOT EXISTS FOR (a:Actor) REQUIRE a.actor_id IS UNIQUE;
CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.entity_id IS UNIQUE;
CREATE CONSTRAINT outcome_id IF NOT EXISTS FOR (o:Outcome) REQUIRE o.outcome_id IS UNIQUE;
CREATE CONSTRAINT event_id IF NOT EXISTS FOR (ev:Event) REQUIRE ev.event_id IS UNIQUE;
CREATE CONSTRAINT context_id IF NOT EXISTS FOR (c:Context) REQUIRE c.context_id IS UNIQUE;
CREATE CONSTRAINT reason_id IF NOT EXISTS FOR (r:Reason) REQUIRE r.reason_id IS UNIQUE;
CREATE CONSTRAINT policy_id IF NOT EXISTS FOR (p:Policy) REQUIRE (p.policy_id, p.version) IS UNIQUE;
CREATE CONSTRAINT decision_type_key IF NOT EXISTS FOR (t:DecisionType) REQUIRE t.key IS UNIQUE;
CREATE CONSTRAINT option_key IF NOT EXISTS FOR (o:Option) REQUIRE (o.decision_type, o.option_key) IS UNIQUE;
CREATE CONSTRAINT schema_element_key IF NOT EXISTS FOR (s:SchemaElement) REQUIRE s.key IS UNIQUE;
CREATE CONSTRAINT schema_change_id IF NOT EXISTS FOR (c:SchemaChange) REQUIRE c.change_id IS UNIQUE;
CREATE CONSTRAINT decision_point_id IF NOT EXISTS FOR (p:DecisionPoint) REQUIRE p.point_id IS UNIQUE;
CREATE CONSTRAINT decision_tree_id IF NOT EXISTS FOR (t:DecisionTree) REQUIRE t.tree_id IS UNIQUE;

// Lookup indexes
CREATE INDEX decision_type_stage IF NOT EXISTS FOR (d:Decision) ON (d.decision_type, d.stage);
CREATE INDEX decision_decided_at IF NOT EXISTS FOR (d:Decision) ON (d.decided_at);
CREATE INDEX outcome_type_occurred_at IF NOT EXISTS FOR (o:Outcome) ON (o.outcome_type, o.occurred_at);
CREATE INDEX entity_source IF NOT EXISTS FOR (e:Entity) ON (e.source_system, e.source_key);
CREATE INDEX event_type IF NOT EXISTS FOR (ev:Event) ON (ev.source_system, ev.event_type);
CREATE INDEX schema_element_status IF NOT EXISTS FOR (s:SchemaElement) ON (s.kind, s.status);
CREATE INDEX decision_tree_scope IF NOT EXISTS FOR (t:DecisionTree) ON (t.decision_type, t.scope);

// Scenario isolation (demo spec Section 11.1): fast cleanup per scenario
CREATE INDEX event_scenario IF NOT EXISTS FOR (n:Event) ON (n.scenario_id);
CREATE INDEX decision_scenario IF NOT EXISTS FOR (n:Decision) ON (n.scenario_id);
CREATE INDEX context_scenario IF NOT EXISTS FOR (n:Context) ON (n.scenario_id);
CREATE INDEX entity_scenario IF NOT EXISTS FOR (n:Entity) ON (n.scenario_id);
CREATE INDEX outcome_scenario IF NOT EXISTS FOR (n:Outcome) ON (n.scenario_id);
CREATE INDEX actor_scenario IF NOT EXISTS FOR (n:Actor) ON (n.scenario_id);
CREATE INDEX event_charge IF NOT EXISTS FOR (n:Event) ON (n.charge_id);
CREATE INDEX event_customer IF NOT EXISTS FOR (n:Event) ON (n.stripe_customer_id);

// Vector index for "find decisions like this one"
// 384 dimensions = local sentence-embedding model (demo spec Section 11)
CREATE VECTOR INDEX context_embedding_v1 IF NOT EXISTS
FOR (c:Context) ON (c.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 384, `vector.similarity_function`: 'cosine' } };
