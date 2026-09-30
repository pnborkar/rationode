import { z } from "zod";
import { ask } from "@/lib/ask";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 120;

const Body = z.object({
  question: z.string().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) })).max(20).default([]),
});

// "Ask": a question about this tenant's decisions, answered with tools over the graph; steps streamed as server-sent events.
async function POST_(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of ask(parsed.data.question, parsed.data.history)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}

// Every request runs in its workspace (demo spec §23.9).
export const POST = withTenant(POST_);
