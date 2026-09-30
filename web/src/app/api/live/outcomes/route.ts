import { z } from "zod";
import { sixtyDaysLater } from "@/lib/liveOutcomes";

export const maxDuration = 120;

// POST {ticket_id}: "60 days later" for a live ticket with a final decision (demo spec §19.3). The outcomes are
// simulated (labelled so) and recorded through the Stripe webhook path.
export async function POST(request: Request) {
  const body = z.object({ ticket_id: z.string().min(1) }).safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: "ticket_id is required" }, { status: 400 });
  const r = await sixtyDaysLater(body.data.ticket_id);
  return Response.json(r, { status: r.ok ? 200 : 422 });
}
