import { revealCase } from "@/lib/cases";
import { withTenant } from "@/lib/tenant";

// GET ?id=: what really happened in a replayed case: the real decision and its outcomes.
async function GET_(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const r = await revealCase(id);
  return r ? Response.json(r) : Response.json({ error: "not found" }, { status: 404 });
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
