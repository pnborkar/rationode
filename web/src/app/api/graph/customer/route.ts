import { customerGraph } from "@/lib/caseGraph";
import { withTenant } from "@/lib/tenant";

async function GET_(request: Request) {
  const email = new URL(request.url).searchParams.get("email");
  if (!email) return Response.json({ error: "email required" }, { status: 400 });
  const graph = await customerGraph(email);
  return graph ? Response.json(graph) : Response.json({ error: "not found" }, { status: 404 });
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
