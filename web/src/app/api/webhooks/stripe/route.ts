// Stripe webhook (demo spec §19.3): refunds, disputes and subscription changes, the outcomes of decisions.
// Production would verify Stripe's signature (Stripe-Signature header, the endpoint's signing secret) here.
import { recordStripe } from "@/lib/stripeWebhook";
import { withTenant } from "@/lib/tenant";

async function POST_(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.type || !body?.id) return Response.json({ error: "expected a Stripe event {id, type, data}" }, { status: 400 });
  return Response.json(await recordStripe([body]));
}

// Every request runs in its workspace (demo spec §23.9).
export const POST = withTenant(POST_);
