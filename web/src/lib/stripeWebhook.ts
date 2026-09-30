// Stripe webhook (demo spec §19.3): the outcomes of decisions arrive as Stripe sends them, and go through the
// live pipeline like the gateway's and Zendesk's events. In production this is how outcomes are tracked; the
// demo's "60 days later" builds the same Stripe events (marked simulated) and records them here too.
import { ingestLive } from "./live";
import type { RawEvent } from "./nativeAdapter";

type Json = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// One Stripe event (as posted by Stripe: {id, type, created, data: {object}}) -> the pipeline's raw events.
// Refunds and disputes are Stripe events as they are; Stripe Billing's subscription events become the
// subscription system's (canceled on customer.subscription.deleted, renewed on a paid renewal invoice).
export function fromStripe(evt: Json): RawEvent[] {
  const o = evt.data?.object ?? {};
  const at = iso(evt.created ?? o.created ?? Math.floor(Date.now() / 1000));
  if (["refund.created", "charge.dispute.created", "charge.dispute.closed"].includes(evt.type)) {
    return [{ event_id: evt.id, source_system: "stripe", event_type: evt.type, occurred_at: at, payload: evt }];
  }
  if (evt.type === "customer.subscription.deleted") {
    return [{ event_id: evt.id, source_system: "subscriptions", event_type: "subscription.canceled", occurred_at: at,
              payload: { subscription_id: o.id, stripe_customer_id: o.customer, plan: o.metadata?.plan ?? null,
                         reason: o.cancellation_details?.reason ?? null, at, simulated: o.metadata?.rationode_simulated ?? false } }];
  }
  if (evt.type === "invoice.paid" && o.billing_reason === "subscription_cycle") {
    return [{ event_id: evt.id, source_system: "subscriptions", event_type: "subscription.renewed", occurred_at: at,
              payload: { subscription_id: o.subscription, stripe_customer_id: o.customer, plan: o.metadata?.plan ?? null,
                         at, simulated: o.metadata?.rationode_simulated ?? false } }];
  }
  return [];   // other Stripe events are not outcomes of a decision
}

export async function recordStripe(events: Json[]) {
  const raws = events.flatMap(fromStripe);
  if (!raws.length) return { recorded: 0 };
  return { recorded: raws.length, ...(await ingestLive(raws)) };
}
