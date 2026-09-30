// GET ?type=&q=: the loaded top-level subjects of any domain (demo spec §23.8), for the Browse panel: those that
// aren't part of another subject (applications, not their offers), with how many decisions and outcomes concern
// them (their parts included). This app's own data only: a tenant's history, or the demo's upload batches.
import neo4j from "neo4j-driver";
import { IS_DEMO, query, SCENARIO } from "@/lib/neo4j";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const type = params.get("type")?.trim() || null;
  const q = params.get("q")?.trim().toLowerCase() || null;
  const scope = `(($demo AND s.scenario_id STARTS WITH 'upload:') OR (NOT $demo AND s.scenario_id = $base))`;
  const types = await query<{ type: string; n: number }>(
    `MATCH (s:Entity) WHERE ${scope} AND s.subject_type IS NOT NULL AND NOT (s)-[:PART_OF]->()
     RETURN s.subject_type AS type, count(*) AS n ORDER BY n DESC`, { demo: IS_DEMO, base: SCENARIO });
  const subjects = await query<{ id: string; label: string; key: string; type: string; parts: number; decisions: number; outcomes: number }>(
    `MATCH (s:Entity) WHERE ${scope} AND s.subject_type IS NOT NULL AND NOT (s)-[:PART_OF]->()
       AND ($type IS NULL OR s.subject_type = $type) AND ($q IS NULL OR toLower(s.source_key) CONTAINS $q)
     WITH s ORDER BY s.source_key LIMIT $limit
     OPTIONAL MATCH (p:Entity)-[:PART_OF]->(s)
     WITH s, collect(p) AS parts
     OPTIONAL MATCH (d:Decision)-[:ABOUT]->(x) WHERE x = s OR x IN parts
     WITH s, parts, collect(DISTINCT d) AS ds
     RETURN s.entity_id AS id, head([l IN labels(s) WHERE l <> 'Entity']) AS label,
            split(s.source_key, ':')[1] AS key, s.subject_type AS type, size(parts) AS parts, size(ds) AS decisions,
            reduce(n = 0, d IN ds | n + COUNT { (d)-[:LED_TO]->() }) AS outcomes`,
    { demo: IS_DEMO, base: SCENARIO, type, q, limit: neo4j.int(200) });
  return Response.json({ types, subjects });
}
