import { z } from "zod";
import { runSupportAgent } from "@/lib/agent";

// An agent run takes ~20 s; allow headroom so a slow run isn't cut off mid-demo.
export const maxDuration = 60;

const Body = z.object({
  ticket_id: z.string(),
  customer_email: z.string(),
  channel: z.enum(["chat", "email"]).default("chat"),
  message: z.string().min(1),
  graph: z.boolean(),
});

// Streams the agent's steps to the browser as server-sent events.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runSupportAgent({ ...parsed.data, origin: new URL(request.url).origin })) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
