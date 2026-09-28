import { query } from "./neo4j";

// The demo's "now": the start of the loop month, after the Jan-Jun history (demo spec Section 5).
export const DEMO_NOW = new Date(process.env.DEMO_NOW ?? "2026-07-01T09:00:00Z");

// Same rule as the simulator's Customer.tenure_months.
function tenureMonths(started: Date, on: Date): number {
  const months = (on.getUTCFullYear() - started.getUTCFullYear()) * 12 + on.getUTCMonth() - started.getUTCMonth()
    - (on.getUTCDate() < started.getUTCDate() ? 1 : 0);
  return Math.max(0, months);
}

export type CustomerInfo = {
  customer_email: string;
  name: string;
  stripe_customer_id: string;
  tenure_months: number;
  plan: string;
  prior_refunds_90d: number;
  subscription_status: string;
  charge_id: string;
  charge_amount_usd: number;
  usage_hours_30d: number | null;   // Streamly app viewing; null = no usage data
  last_watched_week: string | null;
};

// What the support agent's get_customer tool returns: assembled from Stripe and
// subscription-system events already in the graph.
export async function getCustomer(email: string): Promise<CustomerInfo | null> {
  const rows = await query<{
    cus: string; name: string; started: string; plan: string; charge_id: string; amount: number;
    refunds: number; canceled: boolean;
  }>(
    `MATCH (c:Customer:Entity {source_system: 'stripe', email: $email})
     MATCH (sub:Event {event_type: 'subscription.created', stripe_customer_id: c.source_key})
     MATCH (ch:Event {event_type: 'charge.succeeded', stripe_customer_id: c.source_key})
     WHERE ch.occurred_at <= datetime($now)
     WITH c, sub, ch ORDER BY ch.occurred_at DESC
     WITH c, sub, collect(ch)[0] AS last
     OPTIONAL MATCH (r:Event {event_type: 'refund.created'})
       WHERE r.charge_id = last.charge_id AND r.occurred_at >= datetime($now) - duration('P90D')
     OPTIONAL MATCH (x:Event {event_type: 'subscription.canceled', stripe_customer_id: c.source_key})
       WHERE x.occurred_at <= datetime($now)
     RETURN c.source_key AS cus, c.name AS name, apoc.convert.fromJsonMap(sub.payload_json).started_at AS started,
            apoc.convert.fromJsonMap(sub.payload_json).plan AS plan, last.charge_id AS charge_id,
            apoc.convert.fromJsonMap(last.payload_json).data.object.amount / 100.0 AS amount,
            count(DISTINCT r) AS refunds, count(x) > 0 AS canceled`,
    { email, now: DEMO_NOW.toISOString() },
  );
  const r = rows[0];
  if (!r) return null;
  const [u] = await query<{ weeks: number; hours: number; last: string | null }>(
    `MATCH (e:Event {event_type: 'playback.weekly_summary', stripe_customer_id: $cus})
     WHERE e.occurred_at <= datetime($now) AND e.occurred_at > datetime($now) - duration('P30D')
     WITH apoc.convert.fromJsonMap(e.payload_json) AS p
     RETURN count(p) AS weeks, sum(p.hours_watched) AS hours,
            max(CASE WHEN p.hours_watched > 0 THEN p.week_start END) AS last`,
    { cus: r.cus, now: DEMO_NOW.toISOString() },
  );
  return {
    customer_email: email, name: r.name, stripe_customer_id: r.cus,
    tenure_months: tenureMonths(new Date(r.started), DEMO_NOW), plan: r.plan,
    prior_refunds_90d: r.refunds, subscription_status: r.canceled ? "canceled" : "active",
    charge_id: r.charge_id, charge_amount_usd: r.amount,
    usage_hours_30d: u && u.weeks > 0 ? Math.round(u.hours * 10) / 10 : null,
    last_watched_week: u?.last ?? null,
  };
}
