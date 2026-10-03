import { subjectGraph } from "@/lib/caseGraph";
import { query } from "@/lib/neo4j";
import { ownScenario } from "@/lib/scenarios";
import { withTenant } from "@/lib/tenant";

// GET ?id=<entity_id>[&before=<ISO time>]: any subject's decision neighbourhood (demo spec §23.8); with before, only
// what happened before then (a replayed case's graph so far).
async function GET_(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("id"), before = params.get("before");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const [e] = await query<{ s: string }>(`MATCH (e:Entity {entity_id: $id}) RETURN e.scenario_id AS s`, { id });
  if (!e || !ownScenario(e.s)) return Response.json({ error: "not found" }, { status: 404 });   // this app's own data only
  if (before && Number.isNaN(Date.parse(before))) return Response.json({ error: "before must be a date-time" }, { status: 400 });
  const graph = await subjectGraph(id, before);
  return graph ? Response.json(graph) : Response.json({ error: "not found" }, { status: 404 });
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
