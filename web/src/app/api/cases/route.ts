import { replayCase } from "@/lib/cases";

// GET ?type=: a past case replayed as new (only what was known then; the real decision and outcome stay hidden).
export async function GET(request: Request) {
  const c = await replayCase(new URL(request.url).searchParams.get("type") ?? undefined);
  return c ? Response.json(c) : Response.json({ error: "No past decisions with outcomes to replay in this workspace" }, { status: 404 });
}
