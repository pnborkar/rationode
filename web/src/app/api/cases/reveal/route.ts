import { revealCase } from "@/lib/cases";

// GET ?id=: what really happened in a replayed case: the real decision and its outcomes.
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const r = await revealCase(id);
  return r ? Response.json(r) : Response.json({ error: "not found" }, { status: 404 });
}
