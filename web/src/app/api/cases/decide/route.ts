import { z } from "zod";
import { decide } from "@/lib/decide";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 120;

const Case = z.object({
  id: z.string(), decision_type: z.string(), decided_at: z.string(),
  subject: z.object({ id: z.string(), label: z.string(), key: z.string() }),
  parent: z.object({ id: z.string(), label: z.string(), key: z.string(), parts: z.number().default(0) }).nullable(),
  facts: z.record(z.string(), z.unknown()), options: z.array(z.object({ option: z.string(), n: z.number() })),
  details: z.array(z.string()), related: z.array(z.string()),
  history: z.array(z.object({ at: z.string(), kind: z.enum(["decision", "outcome"]), label: z.string(), option: z.string().nullable(),
                              amount: z.number().nullable(), by: z.string().nullable() })).default([]),
  decider: z.string().nullable().default(null),
});

// POST {case}: the generic decision agent's steps and proposal, streamed as server-sent events.
async function POST_(request: Request) {
  const parsed = Case.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const e of decide(parsed.data)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) })}\n\n`));
      } finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}

// Every request runs in its workspace (demo spec §23.9).
export const POST = withTenant(POST_);
