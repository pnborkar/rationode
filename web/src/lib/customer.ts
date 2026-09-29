import { amount, isType, payloadField } from "./eventFields";
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
  refunds_90d: { date: string; amount_usd: number; charge_id: string }[];   // the refunds themselves, not just a count
  latest_charge_refunded_usd: number;                                        // already refunded on the latest charge
};

// What the support agent's get_customer tool returns: assembled from Stripe and
// subscription-system events already in the graph.
export async function getCustomer(email: string): Promise<CustomerInfo | null> {
  const rows = await query<{
    cus: string; name: string; started: string; plan: string; charge_id: string; amount: number;
    refunds: number; canceled: boolean;
  }>(
    `MATCH (c:Customer:Entity {source_system: 'stripe', email: $email})
     MATCH (sub:Event {stripe_customer_id: c.source_key}) WHERE ${isType("sub", "subscription.created")}
     MATCH (ch:Event {stripe_customer_id: c.source_key})
     WHERE ${isType("ch", "charge.succeeded")} AND ch.occurred_at <= datetime($now)
     WITH c, sub, ch ORDER BY ch.occurred_at DESC
     WITH c, sub, collect(ch)[0] AS last
     OPTIONAL MATCH (r:Event {charge_id: last.charge_id})
       WHERE ${isType("r", "refund.created")} AND r.occurred_at >= datetime($now) - duration('P90D')
     OPTIONAL MATCH (x:Event {stripe_customer_id: c.source_key})
       WHERE ${isType("x", "subscription.canceled")} AND x.occurred_at <= datetime($now)
     RETURN c.source_key AS cus, c.name AS name, ${payloadField("sub", "started_at")} AS started,
            ${payloadField("sub", "plan")} AS plan, last.charge_id AS charge_id, ${amount("last")} AS amount,
            count(DISTINCT r) AS refunds, count(x) > 0 AS canceled`,
    { email, now: DEMO_NOW.toISOString() },
  );
  const r = rows[0];
  if (!r) return null;
  const refunds = await query<{ date: string; amount_usd: number; charge_id: string }>(
    `MATCH (ch:Event {stripe_customer_id: $cus}) WHERE ${isType("ch", "charge.succeeded")}
     MATCH (rf:Event {charge_id: ch.charge_id})
     WHERE ${isType("rf", "refund.created")}
       AND rf.occurred_at <= datetime($now) AND rf.occurred_at >= datetime($now) - duration('P90D')
     RETURN toString(date(rf.occurred_at)) AS date, rf.charge_id AS charge_id, ${amount("rf")} AS amount_usd
     ORDER BY date`,
    { cus: r.cus, now: DEMO_NOW.toISOString() },
  );
  return {
    customer_email: email, name: r.name, stripe_customer_id: r.cus,
    tenure_months: tenureMonths(new Date(r.started), DEMO_NOW), plan: r.plan,
    prior_refunds_90d: r.refunds, subscription_status: r.canceled ? "canceled" : "active",
    charge_id: r.charge_id, charge_amount_usd: r.amount,
    refunds_90d: refunds,
    latest_charge_refunded_usd: refunds.filter((x) => x.charge_id === r.charge_id).reduce((t, x) => t + x.amount_usd, 0),
  };
}

export type UsagePattern =
  | { usage_data: false; note: string }
  | {
      usage_data: true;
      weeks: { week_start: string; hours: number; titles: number; after_charge: boolean }[];
      latest_charge: { date: string; amount_usd: number };
      hours_since_charge: number;
      weeks_since_charge: number;
      last_watched_week: string | null;
      trend: "none" | "stopped" | "declining" | "steady";
    };

// check_usage_patterns: weekly viewing from the Streamly app, as facts (no verdict). Only prepared
// customers have usage data, so there is deliberately no comparison with a "typical" customer.
export async function checkUsage(email: string): Promise<UsagePattern | null> {
  const [c] = await query<{ cus: string; charged: string | null; amount: number | null }>(
    `MATCH (c:Customer:Entity {source_system: 'stripe', email: $email})
     OPTIONAL MATCH (ch:Event {stripe_customer_id: c.source_key})
       WHERE ${isType("ch", "charge.succeeded")} AND ch.occurred_at <= datetime($now)
     WITH c, ch ORDER BY ch.occurred_at DESC
     WITH c, collect(ch)[0] AS last
     RETURN c.source_key AS cus, toString(date(last.occurred_at)) AS charged, ${amount("last")} AS amount`,
    { email, now: DEMO_NOW.toISOString() },
  );
  if (!c) return null;
  const rows = await query<{ week: string; hours: number; titles: number }>(
    `MATCH (e:Event {stripe_customer_id: $cus})
     WHERE ${isType("e", "usage.weekly")} AND e.occurred_at <= datetime($now)
     WITH coalesce(apoc.convert.fromJsonMap(e.data_json), apoc.convert.fromJsonMap(e.payload_json)) AS p
     RETURN p.week_start AS week, p.hours_watched AS hours, p.titles_watched AS titles
     ORDER BY week DESC LIMIT 6`,
    { cus: c.cus, now: DEMO_NOW.toISOString() },
  );
  if (!rows.length) return { usage_data: false, note: "No usage data from the Streamly app for this customer." };
  const weeks = rows.reverse().map((w) => {
    const weekEnd = new Date(new Date(w.week).getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
    return { week_start: w.week, hours: w.hours, titles: w.titles, after_charge: !!c.charged && weekEnd >= c.charged };
  });
  const since = weeks.filter((w) => w.after_charge);
  const hours = (ws: typeof weeks) => ws.reduce((s, w) => s + w.hours, 0);
  const recent = weeks.slice(-2), earlier = weeks.slice(0, -2);
  const avg = (ws: typeof weeks) => (ws.length ? hours(ws) / ws.length : 0);
  const trend = hours(weeks) === 0 ? "none"
    : hours(recent) === 0 && hours(earlier) > 0 ? "stopped"
    : earlier.length && avg(recent) < 0.6 * avg(earlier) ? "declining" : "steady";
  return {
    usage_data: true, weeks,
    latest_charge: { date: c.charged ?? "", amount_usd: c.amount ?? 0 },
    hours_since_charge: Math.round(hours(since) * 10) / 10, weeks_since_charge: since.length,
    last_watched_week: [...weeks].reverse().find((w) => w.hours > 0)?.week_start ?? null,
    trend,
  };
}
