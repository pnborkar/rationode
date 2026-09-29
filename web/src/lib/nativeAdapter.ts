// Native adapter: Streamly's vendor payloads (Stripe webhooks, Zendesk events, gateway tool-call
// logs, FraudGuard, subscriptions, Streamly app) -> contract events. Port of
// pipeline/src/rationode/pipeline/parse.py. Uploaded exports go through a mapping instead.
import type { Actor, CanonicalType, ContractEvent, EntityRefs } from "./contract";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export type RawEvent = {
  event_id: string;
  source_system: string;
  event_type: string;
  occurred_at: string;
  payload: Json;
};

const STRIPE_CATEGORY: Record<string, string> = {
  subscription_canceled: "subscription_canceled", unrecognized: "not_recognized",
  fraudulent: "unauthorized", duplicate: "duplicate_charge",
};

const MACRO_OPTION: Record<string, string> = {
  "Refund: full": "full_refund", "Refund: partial (50%)": "partial_refund",
  "Voucher: 20% credit": "voucher", "Deny refund": "deny", "Pause subscription": "pause_subscription",
};

const AGENT_TOOL: Record<string, CanonicalType> = {
  get_customer: "agent.customer_lookup", propose_resolution: "agent.proposal",
  get_dispute_evidence: "agent.dispute_lookup", respond_to_dispute: "agent.dispute_response",
};

const FRAUDGUARD: Actor = { kind: "SYSTEM", id: "system:fraudguard", version: "rules-2026.1", name: "FraudGuard rules" };
const SUPPORT_AGENT_ZENDESK_ID = "streamly-support-agent";   // the AI agent's Zendesk user

const pick = (o: Json, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// Returns null for records the detector has no use for (they are still worth keeping as raw events).
export function toContract(r: RawEvent): ContractEvent | null {
  const p = r.payload, src = r.source_system, typ = r.event_type;
  let type: CanonicalType | null = null;
  let refs: EntityRefs = {};
  let data: Record<string, unknown> = {};
  let actor: Actor | null = null;

  if (src === "fraudguard") {
    type = "charge.screened";
    refs = { charge_id: p.charge_ref, customer_email: p.customer_email };
    data = pick(p, ["risk_score", "plan", "is_renewal", "country_match", "card_age_days", "decision", "amount", "rule_id"]);
    actor = FRAUDGUARD;
  } else if (src === "stripe") {
    const o = p.data.object;
    if (typ === "charge.succeeded") {
      type = "charge.succeeded";
      refs = { charge_id: o.id, stripe_customer_id: o.customer, customer_email: o.billing_details.email };
      data = { amount: o.amount / 100, name: o.billing_details.name, plan: o.metadata.plan };
    } else if (typ === "refund.created") {
      type = "refund.created";
      refs = { charge_id: o.charge, ticket_id: o.metadata.zendesk_ticket_id ?? null };
      data = { amount: o.amount / 100, initiated_by: o.metadata.initiated_by ?? null };
    } else if (typ === "charge.dispute.created" || typ === "charge.dispute.closed") {
      type = typ === "charge.dispute.created" ? "dispute.created" : "dispute.closed";
      refs = { dispute_id: o.id, charge_id: o.charge };
      data = { amount: o.amount / 100, category: STRIPE_CATEGORY[o.reason], status: o.status };
    }
  } else if (src === "zendesk") {
    if (typ === "ticket.created") {
      const t = p.ticket;
      const fields = Object.fromEntries((t.custom_fields ?? []).map((f: Json) => [f.id, f.value]));
      type = "ticket.created";
      refs = { ticket_id: String(t.id), customer_email: t.requester.email, charge_id: fields.stripe_charge_id ?? null };
      data = { category: t.tags.length ? t.tags[0] : null, channel: t.via.channel, subject: t.subject, name: t.requester.name };
    } else if (typ === "macro.applied") {
      type = "rep.decision";
      refs = { ticket_id: String(p.ticket_id) };
      data = { option: MACRO_OPTION[p.macro.title] ?? null, macro: p.macro.title };
      actor = { kind: "HUMAN", id: `zendesk:${p.actor.id}`, name: p.actor.name, team: p.actor.group };
    } else if (typ === "ticket.updated" && ["solved", "closed"].includes(p.changes?.status?.to)) {
      type = "ticket.closed";
      refs = { ticket_id: String(p.ticket_id) };
      data = { status: p.changes.status.to };
      actor = p.actor.id === SUPPORT_AGENT_ZENDESK_ID
        ? { kind: "AI_AGENT", id: `zendesk:${p.actor.id}` }
        : { kind: "HUMAN", id: `zendesk:${p.actor.id}`, name: p.actor.name ?? null };
    }
  } else if (src === "mcp_gateway") {
    type = AGENT_TOOL[p.tool] ?? null;
    const args = p.arguments, res = p.result;
    refs = {
      session_id: p.session_id, ticket_id: "ticket_id" in args ? String(args.ticket_id) : null,
      dispute_id: args.dispute_id ?? null, charge_id: res.charge_id ?? null, customer_email: res.customer_email ?? null,
    };
    const v = p.agent_version;
    actor = { kind: "AI_AGENT", id: `agent:${p.agent_id}:${v}`, version: v, name: `Streamly support agent ${v}` };
    if (type === "agent.customer_lookup") data = pick(res, ["tenure_months", "plan", "charge_amount_usd", "prior_refunds_90d"]);
    else if (type === "agent.proposal") data = { option: args.option, amount_usd: args.amount_usd };
    else if (type === "agent.dispute_lookup") data = {
      category: res.category, amount_usd: res.amount_usd, tenure_months: res.customer_tenure_months,
      prior_complaint: res.prior_complaint, available_evidence: res.available_evidence,
    };
    else if (type === "agent.dispute_response") data = { action: args.action, evidence: args.evidence ?? [] };
  } else if (src === "streamly_app") {
    type = "usage.weekly";
    refs = { stripe_customer_id: p.stripe_customer_id, customer_email: p.email ?? null };
    data = { week_start: p.week_start, hours_watched: p.hours_watched, titles_watched: p.titles_watched };
  } else if (src === "subscriptions" && typ.startsWith("subscription.")) {
    type = typ as CanonicalType;
    refs = { subscription_id: p.subscription_id, stripe_customer_id: p.stripe_customer_id, customer_email: p.email ?? null };
    data = { plan: p.plan, started_at: p.started_at ?? null, reason: p.reason ?? null };
  }

  if (!type) return null;
  return {
    event_id: r.event_id, source: src, source_type: typ, event_type: type, occurred_at: r.occurred_at,
    received_at: null, entity_refs: refs, actor, data, raw: p,
  };
}
