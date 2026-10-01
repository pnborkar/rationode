import { sourceMapping } from "@/lib/uploads";
import { withTenant } from "@/lib/tenant";

// GET /api/upload/mapping?source=: the mapping a workspace source's latest load approved (§23.8 Gap 1), to reuse.
async function GET_(request: Request) {
  const source = new URL(request.url).searchParams.get("source")?.trim();
  if (!source) return Response.json({ error: "source is required" }, { status: 400 });
  const m = await sourceMapping(source);
  return m ? Response.json(m) : Response.json({ error: `No approved mapping for "${source}"` }, { status: 404 });
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
