import { z } from "zod";
import { CHOICES, sixtyDaysLater, type Choice } from "@/lib/liveOutcomes";

export const maxDuration = 120;

// POST {ticket_id, choice?}: "60 days later" for a live ticket with a final decision (demo spec §19.3). The outcome
// is drawn from the world model, or chosen by the presenter (choice); either way simulated, labelled so, and
// recorded through the Stripe webhook path.
export async function POST(request: Request) {
  const body = z.object({ ticket_id: z.string().min(1), choice: z.enum(CHOICES as [Choice, ...Choice[]]).optional() })
    .safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: "ticket_id is required; choice is one of " + CHOICES.join(", ") }, { status: 400 });
  const r = await sixtyDaysLater(body.data.ticket_id, body.data.choice);
  return Response.json(r, { status: r.ok ? 200 : 422 });
}
