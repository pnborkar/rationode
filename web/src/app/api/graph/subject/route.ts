import { subjectGraph } from "@/lib/caseGraph";
import { IS_DEMO, query, SCENARIO } from "@/lib/neo4j";

// GET ?id=<entity_id>: any subject's decision neighbourhood (demo spec §23.8). Only this app's own data.
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const [e] = await query<{ s: string }>(`MATCH (e:Entity {entity_id: $id}) RETURN e.scenario_id AS s`, { id });
  if (!e || !(e.s === SCENARIO || (IS_DEMO && e.s.startsWith("upload:")))) return Response.json({ error: "not found" }, { status: 404 });
  const graph = await subjectGraph(id);
  return graph ? Response.json(graph) : Response.json({ error: "not found" }, { status: 404 });
}
