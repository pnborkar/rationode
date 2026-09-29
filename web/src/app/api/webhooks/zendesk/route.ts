// Zendesk webhook (demo spec §19): the help chat opening a ticket and the rep's macro (Approve/override)
// arrive as Zendesk-format events and go through the live pipeline.
import { z } from "zod";
import { demoClock, ingestLive, newId, removeLiveTicket } from "@/lib/live";
import { query } from "@/lib/neo4j";

const Body = z.object({ type: z.enum(["ticket.created", "macro.applied", "ticket.updated"]) }).passthrough();

export async function POST(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  const payload = body.data as Record<string, unknown> & { type: string; ticket?: { id: string } };
  if (payload.type === "ticket.created" && payload.ticket?.id) {
    await removeLiveTicket(String(payload.ticket.id));   // re-running a case starts its ticket afresh
  }
  const result = await ingestLive([{ event_id: newId("zdevt"), source_system: "zendesk", event_type: payload.type,
                                     occurred_at: demoClock(), payload }]);
  // This ticket's decisions, so the caller can link what it drew to what was recorded.
  const ticket = String(payload.ticket?.id ?? payload.ticket_id ?? "");
  const ticketDecisions = ticket ? await query<{ id: string; stage: string }>(
    `MATCH (d:Decision {scenario_id: 'live'})-[:EVIDENCED_BY]->(:Event {scenario_id: 'live', ticket_id: $ticket})
     RETURN DISTINCT d.decision_id AS id, d.stage AS stage`, { ticket }) : [];
  return Response.json({ ...result, ticket_decisions: ticketDecisions });
}
