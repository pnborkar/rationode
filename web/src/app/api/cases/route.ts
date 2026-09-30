import { replayCase } from "@/lib/cases";
import { withTenant } from "@/lib/tenant";

// GET ?type=: a past case replayed as new (only what was known then; the real decision and outcome stay hidden).
async function GET_(request: Request) {
  const c = await replayCase(new URL(request.url).searchParams.get("type") ?? undefined);
  return c ? Response.json(c) : Response.json({ error: "No past decisions with outcomes to replay in this workspace" }, { status: 404 });
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
