// GET ?scenario=&type=&q=: the Browse tab (demo spec §23.8). The scenarios this app can see (never another tenant's):
// the demo's history, loaded sets, upload batches and live decisions; a tenant's history and live decisions. In each,
// the top-level subjects: any domain's generic subjects not part of another (applications, not their offers), and
// Streamly's customers; with how many decisions and outcomes concern them (their parts included).
import neo4j from "neo4j-driver";
import { query, SCENARIO } from "@/lib/neo4j";
import { ownScenario } from "@/lib/scenarios";


const SUBJECT = `(s.subject_type IS NOT NULL OR (s:Customer AND s.source_system = 'stripe')) AND NOT (s)-[:PART_OF]->()`;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const type = params.get("type")?.trim() || null;
  const q = params.get("q")?.trim().toLowerCase() || null;
  const found = (await query<{ scenario: string; n: number }>(
    `MATCH (s:Entity) WHERE ${SUBJECT} AND s.scenario_id IS NOT NULL
     RETURN s.scenario_id AS scenario, count(*) AS n ORDER BY scenario`)).filter((x) => ownScenario(x.scenario));
  const scenario = params.get("scenario") && ownScenario(params.get("scenario")!) ? params.get("scenario")! : found[0]?.scenario ?? SCENARIO;
  const types = await query<{ type: string; n: number }>(
    `MATCH (s:Entity {scenario_id: $scenario}) WHERE ${SUBJECT}
     RETURN coalesce(s.subject_type, 'customer') AS type, count(*) AS n ORDER BY n DESC`, { scenario });
  const subjects = await query<{ id: string; label: string; key: string; type: string; email: string | null; parts: number; decisions: number; outcomes: number }>(
    `MATCH (s:Entity {scenario_id: $scenario}) WHERE ${SUBJECT}
       AND ($type IS NULL OR coalesce(s.subject_type, 'customer') = $type)
       AND ($q IS NULL OR toLower(s.source_key) CONTAINS $q OR toLower(coalesce(s.email, '')) CONTAINS $q OR toLower(coalesce(s.name, '')) CONTAINS $q)
     WITH s ORDER BY coalesce(s.name, s.source_key) LIMIT $limit
     OPTIONAL MATCH (p:Entity)-[:PART_OF]->(s)
     WITH s, collect(p) AS parts
     OPTIONAL MATCH (d:Decision)-[:ABOUT]->(x) WHERE x = s OR x IN parts
     WITH s, parts, collect(DISTINCT d) AS ds
     RETURN s.entity_id AS id, head([l IN labels(s) WHERE l <> 'Entity']) AS label,
            coalesce(s.name, split(s.source_key, ':')[1], s.source_key) AS key, coalesce(s.subject_type, 'customer') AS type, s.email AS email,
            size(parts) AS parts, size(ds) AS decisions, reduce(n = 0, d IN ds | n + COUNT { (d)-[:LED_TO]->() }) AS outcomes`,
    { scenario, type, q, limit: neo4j.int(200) });
  return Response.json({ scenarios: found, scenario, types, subjects });
}
