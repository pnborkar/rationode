// GET ?scenario=&type=&q=: the Browse tab (demo spec §23.8). The scenarios this app can see (never another tenant's):
// the demo's history, loaded sets, upload batches and live decisions; a tenant's history and live decisions. In each,
// the 500 top-level subjects with the most recent decisions (any domain's generic subjects, e.g. applications, and
// Streamly's customers), newest first, with how many decisions and outcomes concern them (their parts included).
import neo4j from "neo4j-driver";
import { query, baseScenario } from "@/lib/neo4j";
import { ownScenario } from "@/lib/scenarios";
import { withTenant } from "@/lib/tenant";



async function GET_(request: Request) {
  const params = new URL(request.url).searchParams;
  const type = params.get("type")?.trim() || null;
  const q = params.get("q")?.trim().toLowerCase() || null;
  // The picker: this app's scenarios by their decisions (the Decision scenario index, fast).
  const found = (await query<{ scenario: string; n: number }>(
    `MATCH (d:Decision) WHERE d.scenario_id IS NOT NULL RETURN d.scenario_id AS scenario, count(*) AS n ORDER BY scenario`))
    .filter((x) => ownScenario(x.scenario));
  const scenario = params.get("scenario") && ownScenario(params.get("scenario")!) ? params.get("scenario")! : found[0]?.scenario ?? baseScenario();
  // The 500 subjects with the most recent decisions, newest first: each decision's subject, or the subject it is part of.
  const subjects = await query<{ id: string; label: string; key: string; type: string; email: string | null; last: string;
                                 parts: number; decisions: number; outcomes: number }>(
    `MATCH (d:Decision {scenario_id: $scenario})-[:ABOUT]->(x:Entity)
     WHERE x.subject_type IS NOT NULL OR (x:Customer AND x.source_system = 'stripe')
     OPTIONAL MATCH (x)-[:PART_OF]->(p:Entity)
     WITH coalesce(p, x) AS s, d
     WHERE ($type IS NULL OR coalesce(s.subject_type, 'customer') = $type)
       AND ($q IS NULL OR toLower(s.source_key) CONTAINS $q OR toLower(coalesce(s.email, '')) CONTAINS $q OR toLower(coalesce(s.name, '')) CONTAINS $q)
     WITH s, max(d.decided_at) AS last, collect(DISTINCT d) AS ds
     ORDER BY last DESC LIMIT $limit
     RETURN s.entity_id AS id, head([l IN labels(s) WHERE l <> 'Entity']) AS label,
            coalesce(s.name, split(s.source_key, ':')[1], s.source_key) AS key, coalesce(s.subject_type, 'customer') AS type,
            s.email AS email, toString(last) AS last, COUNT { (:Entity)-[:PART_OF]->(s) } AS parts, size(ds) AS decisions,
            reduce(n = 0, d IN ds | n + COUNT { (d)-[:LED_TO]->() }) AS outcomes`,
    { scenario, type, q, limit: neo4j.int(500) });
  const types = [...subjects.reduce((m, x) => m.set(x.type, (m.get(x.type) ?? 0) + 1), new Map<string, number>())]
    .map(([t, n]) => ({ type: t, n }));
  return Response.json({ scenarios: found, scenario, types, subjects });
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
