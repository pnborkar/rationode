// "60 days later" for live tickets (demo spec §19.3): what happened after a live decision. In production the
// outcomes arrive by themselves (Stripe and billing webhooks). In the demo nobody disputes or cancels, so this
// draws them from the world model the history was generated with (outcome-model.json, exported from the
// Python world), seeded per ticket so a replay gives the same result, builds the Stripe events that would
// have arrived (marked simulated) and records them through the Stripe webhook path. Then the ticket's
// outcome window is closed: its decisions count as precedent and are placed in the decision trees.
import model from "../data/outcome-model.json";
import { LIVE } from "./live";
import { query } from "./neo4j";
import { placeScenario, type BranchChange } from "./storyTrees";
import { recordStripe } from "./stripeWebhook";

type Facts = {
  decision: string; decided_at: string; option: string; amount: number | null; ctx: Record<string, unknown>;
  charge: string | null; charge_amount: number | null; customer: string | null; window_closed: string | null;
};

// Stripe's dispute reasons for the categories (as the simulator's formats.py).
const STRIPE_REASON: Record<string, string> = { subscription_canceled: "subscription_canceled", not_recognized: "unrecognized",
                                                unauthorized: "fraudulent", duplicate_charge: "duplicate" };

// A small seeded generator (mulberry32) keyed by the ticket, so the same ticket always draws the same outcome.
function rng(seed: string) {
  let h = 1779033703;
  for (const ch of seed) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (usd: number) => Math.round(usd * 100);
const round2 = (usd: number) => Math.round(usd * 100) / 100;
const addDays = (iso: string, days: number) => Math.floor(new Date(iso).getTime() / 1000 + days * 86400);

async function facts(ticket: string): Promise<Facts | null> {
  const [f] = await query<Facts>(
    `MATCH (d:Decision {scenario_id: $live, stage: 'FINAL', decision_type: 'support.complaint_resolution'})
           -[:EVIDENCED_BY]->(:Event {ticket_id: $ticket})
     MATCH (d)-[k:CONSIDERED {status: 'CHOSEN'}]->(o:Option)
     MATCH (d)-[:HAD_CONTEXT]->(c:Context)
     OPTIONAL MATCH (d)-[:ABOUT]->(ch:Charge)
     OPTIONAL MATCH (d)-[:ABOUT]->(cu:Customer {source_system: 'stripe'})
     RETURN d.decision_id AS decision, toString(d.decided_at) AS decided_at, o.option_key AS option, k.amount_usd AS amount,
            properties(c) AS ctx, ch.source_key AS charge, ch.amount_usd AS charge_amount, cu.source_key AS customer,
            toString(d.outcome_window_closed_at) AS window_closed
     LIMIT 1`, { live: LIVE, ticket });
  return f ?? null;
}

async function subscriptionOf(customer: string): Promise<string | null> {
  const [r] = await query<{ id: string | null }>(
    `MATCH (e:Event {stripe_customer_id: $cus}) WHERE e.event_type STARTS WITH 'subscription.'
     RETURN apoc.convert.fromJsonMap(e.payload_json).subscription_id AS id LIMIT 1`, { cus: customer });
  return r?.id ?? null;
}

// How the outcome was set: drawn from the world model, or chosen by the presenter (to tell a particular story;
// labelled so on screen and recorded on the decision as outcome_simulated = 'presenter').
export type Choice = "dispute" | "churn" | "renewal" | "none";
export const CHOICES: Choice[] = ["dispute", "churn", "renewal", "none"];

export type Drawn = { kind: "refund" | "dispute" | "churn" | "renewal" | "none"; days: number; amount?: number; detail: string };

// Draw the outcome as generate.py does for a complaint's final decision, and build the Stripe events for it.
function draw(ticket: string, f: Facts, subscription: string | null, choice?: Choice) {
  const r = rng(`${LIVE}:${ticket}:${f.decision}`);
  const ctx = f.ctx;
  const amount = Number(ctx["support.amount_usd"] ?? f.charge_amount ?? 0);
  const category = String(ctx["support.complaint_category"] ?? "didnt_use");
  const tenure = Number(ctx["support.tenure_months"] ?? 0);
  const plan = String(ctx["support.plan"] ?? "");
  const long = tenure >= model.long_tenure_months;
  const events: Record<string, unknown>[] = [], drawn: Drawn[] = [];
  let n = 0;
  const evt = (type: string, created: number, object: Record<string, unknown>) =>
    events.push({ id: `evt_sim_${ticket}_${++n}`, object: "event", type, created, livemode: false,
                  data: { object: { ...object, metadata: { ...(object.metadata as object ?? {}), rationode_simulated: true,
                                                           ...(choice ? { rationode_chosen_by: "presenter" } : {}) } } } });

  // The refund itself, as decided (the rep's amount when given), right after the decision.
  const refund = ["full_refund", "partial_refund"].includes(f.option)
    ? round2(f.amount ?? (f.option === "full_refund" ? amount : amount * model.partial_refund_share)) : 0;
  if (refund && f.charge) {
    evt("refund.created", addDays(f.decided_at, 1 / 1440), { id: `re_sim_${ticket}`, object: "refund", amount: cents(refund),
        currency: "usd", charge: f.charge, status: "succeeded", metadata: { zendesk_ticket_id: ticket, initiated_by: "zd_live_rep" } });
    drawn.push({ kind: "refund", days: 0, amount: refund, detail: `refund of $${refund} issued` });
  }
  // Then, as in the history: a dispute with the bank, else churn, else (monthly plans) a renewal.
  const probs = f.option === "deny" && category === "too_expensive"
    ? model.too_expensive_deny : model.complaint_outcomes[f.option as keyof typeof model.complaint_outcomes];
  const [disputeP, churnP] = probs ? (long ? [probs[0], probs[2]] : [probs[1], probs[3]]) : [0, 0];
  const between = ([lo, hi]: number[]) => lo + r() * (hi - lo);
  // Drawn as the history was (dispute, else churn, else a monthly renewal), unless the presenter chose.
  const kind: Choice = choice ?? (r() < disputeP && f.charge ? "dispute" : r() < churnP && f.customer ? "churn"
    : plan.startsWith("monthly") && r() < model.monthly_renewal_if_no_churn && f.customer ? "renewal" : "none");
  if (kind === "dispute" && f.charge) {
    const table = model.dispute_category_after_complaint[category as keyof typeof model.dispute_category_after_complaint]
      ?? [["subscription_canceled", 1]];
    let x = r(), cat = String(table[0][0]);
    for (const [c, p] of table) { if ((x -= Number(p)) < 0) { cat = String(c); break; } }
    const days = between(model.days.dispute);
    const disputed = round2(amount - (f.option === "partial_refund" ? refund : 0));
    evt("charge.dispute.created", addDays(f.decided_at, days), { id: `dp_sim_${ticket}`, object: "dispute", amount: cents(disputed),
        currency: "usd", charge: f.charge, reason: STRIPE_REASON[cat] ?? "general", status: "needs_response" });
    drawn.push({ kind: "dispute", days: Math.round(days), amount: disputed,
                 detail: `the customer disputed $${disputed} with their bank (${cat.replaceAll("_", " ")})` });
  } else if (kind === "churn" && f.customer) {
    const days = between(model.days.churn);
    evt("customer.subscription.deleted", addDays(f.decided_at, days), { id: subscription ?? `sub_of_${f.customer}`, object: "subscription",
        customer: f.customer, status: "canceled", cancellation_details: { reason: "cancellation_requested" }, metadata: { plan } });
    drawn.push({ kind: "churn", days: Math.round(days), detail: "the customer canceled their subscription" });
  } else if (kind === "renewal" && f.customer) {
    const days = between(model.days.renewal);
    evt("invoice.paid", addDays(f.decided_at, days), { id: `in_sim_${ticket}`, object: "invoice", customer: f.customer,
        subscription: subscription ?? `sub_of_${f.customer}`, billing_reason: "subscription_cycle", metadata: { plan } });
    drawn.push({ kind: "renewal", days: Math.round(days), detail: "the customer renewed" });
  }
  if (!drawn.some((d) => d.kind !== "refund")) {
    drawn.push({ kind: "none", days: 60, detail: "no dispute and no cancellation within 60 days" });
  }
  return { events, drawn };
}

// Press "60 days later" on a live ticket: outcomes recorded (simulated), outcome window closed, decisions placed.
export async function sixtyDaysLater(ticket: string, choice?: Choice) {
  const f = await facts(ticket);
  if (!f) return { ok: false as const, error: "This ticket has no final decision yet: approve or override first." };
  if (f.window_closed) return { ok: false as const, error: "60 days have already passed for this ticket." };
  if (choice === "dispute" && !f.charge) return { ok: false as const, error: "No charge on this ticket to dispute." };
  if ((choice === "churn" || choice === "renewal") && !f.customer) return { ok: false as const, error: "No customer subscription found." };
  const { events, drawn } = draw(ticket, f, f.customer ? await subscriptionOf(f.customer) : null, choice);
  if (events.length) await recordStripe(events);
  // The window closes for the ticket's decisions (the AI's proposal and the rep's final): they now count.
  const ids = (await query<{ id: string }>(
    `MATCH (d:Decision {scenario_id: $live})-[:EVIDENCED_BY]->(:Event {scenario_id: $live, ticket_id: $ticket})
     SET d.outcome_window_closed_at = datetime($closed), d.outcome_simulated = $how
     RETURN DISTINCT d.decision_id AS id`,
    { live: LIVE, ticket, closed: new Date(addDays(f.decided_at, 60) * 1000).toISOString(), how: choice ? "presenter" : "model" })).map((r) => r.id);
  const branches: BranchChange[] = await placeScenario(LIVE, ids);
  const outcomes = await query<{ type: string; value: number | null; link: string }>(
    `MATCH (d:Decision {decision_id: $id})-[l:LED_TO]->(o:Outcome)
     RETURN o.outcome_type AS type, o.value_usd AS value, l.attribution_method AS link`, { id: f.decision });
  return { ok: true as const, simulated: true, chosen_by: choice ? "presenter" as const : "model" as const,
           ticket, decision: f.decision, option: f.option, drawn, outcomes, branches };
}
