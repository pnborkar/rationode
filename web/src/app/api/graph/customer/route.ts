import { customerGraph } from "@/lib/caseGraph";

export async function GET(request: Request) {
  const email = new URL(request.url).searchParams.get("email");
  if (!email) return Response.json({ error: "email required" }, { status: 400 });
  const graph = await customerGraph(email);
  return graph ? Response.json(graph) : Response.json({ error: "not found" }, { status: 404 });
}
