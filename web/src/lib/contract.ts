// The event contract (demo spec §16.1, ARCHITECTURE.md): one neutral shape every door produces:
// native adapters for known vendor payloads, mappings for uploaded exports, later webhooks and
// the MCP gateway. The detector reads only contract events.

export const CANONICAL_TYPES = [
  "charge.screened", "charge.identifiers", "charge.succeeded", "refund.created", "dispute.created", "dispute.closed",
  "ticket.created", "rep.decision", "ticket.closed",
  "agent.customer_lookup", "agent.proposal", "agent.dispute_lookup", "agent.dispute_response", "agent.tool_call",
  "subscription.created", "subscription.renewed", "subscription.canceled", "subscription.paused",
  "usage.weekly",
  // Generic decision events (demo spec §23.8): any domain's explicit decisions, with no domain pack.
  "decision.proposed", "decision.made", "context.observed", "outcome.observed",
] as const;

export const GENERIC_TYPES = ["decision.proposed", "decision.made", "context.observed", "outcome.observed"] as const;
export const isGeneric = (t: string) => (GENERIC_TYPES as readonly string[]).includes(t);

export type CanonicalType = (typeof CANONICAL_TYPES)[number];

export const ENTITY_REFS = [
  "customer_email", "stripe_customer_id", "charge_id", "ticket_id", "dispute_id", "subscription_id", "session_id",
  "card_fingerprint", "device_id",
  // Generic subjects (§23.8): what a decision, fact or outcome is about, its parent, and an explicit link to the
  // decision (or proposal) it follows, by that record's own ID.
  "subject_type", "subject_id", "parent_type", "parent_id", "follows_id",
] as const;

export type EntityRefs = Partial<Record<(typeof ENTITY_REFS)[number], string | null>>;

export type Actor = {
  kind: "HUMAN" | "AI_AGENT" | "SYSTEM";
  id: string;                 // namespaced by source, e.g. "zendesk:zd_a01", "agent:streamly-support-agent:v2.3"
  name?: string | null;
  team?: string | null;
  version?: string | null;
};

export type ContractEvent = {
  event_id: string;           // deterministic: the source record's own ID
  source: string;             // source system, e.g. "stripe", "zendesk", "mcp_gateway"
  source_type: string;        // the record's type in its own system (kept on the Event node for provenance)
  event_type: CanonicalType;
  occurred_at: string;        // ISO 8601, UTC
  received_at?: string | null;
  entity_refs: EntityRefs;
  actor?: Actor | null;
  data: Record<string, unknown>;   // type-specific normalized fields (see DATA_FIELDS)
  raw: Record<string, unknown>;    // the original record
  source_ref?: { file: string; row: number } | null;   // where the record came from (uploads: file + data row)
};

// Normalized data fields per canonical type: what the detector reads. Required ones must be present.
export const DATA_FIELDS: Record<CanonicalType, { required: string[]; optional?: string[] }> = {
  "charge.screened": { required: ["decision", "risk_score", "amount", "plan", "is_renewal", "country_match", "card_age_days"], optional: ["rule_id", "card_country", "ip_country"] },
  "charge.identifiers": { required: [], optional: ["card_country", "ip_country"] },
  "charge.succeeded": { required: ["amount"], optional: ["name", "plan"] },
  "refund.created": { required: ["amount"], optional: ["initiated_by"] },
  "dispute.created": { required: ["amount"], optional: ["category", "status"] },
  "dispute.closed": { required: ["amount", "status"], optional: ["category"] },
  "ticket.created": { required: ["category", "channel"], optional: ["subject", "name"] },
  "rep.decision": { required: ["option"], optional: ["macro", "amount_usd", "reason"] },
  "ticket.closed": { required: [], optional: ["status"] },
  "agent.customer_lookup": { required: ["tenure_months", "plan", "charge_amount_usd", "prior_refunds_90d"] },
  "agent.proposal": { required: ["option"], optional: ["amount_usd", "category"] },
  "agent.dispute_lookup": { required: ["category", "amount_usd", "tenure_months", "prior_complaint", "available_evidence"] },
  "agent.dispute_response": { required: ["action"], optional: ["evidence"] },
  "agent.tool_call": { required: [], optional: ["tool"] },   // any other tool call: recorded, not a decision
  "subscription.created": { required: [], optional: ["plan", "started_at"] },
  "subscription.renewed": { required: [], optional: ["plan"] },
  "subscription.canceled": { required: [], optional: ["plan", "reason"] },
  "subscription.paused": { required: [], optional: ["plan", "reason"] },
  "usage.weekly": { required: ["week_start", "hours_watched"], optional: ["titles_watched"] },
  // Generic (§23.8). Besides these, decision and context events may carry any number of facts as data.context.<name>
  // (known at the time) and decisions any number of details as data.detail.<name> (e.g. offered terms).
  "decision.proposed": { required: ["decision_type", "option"], optional: ["amount", "reason"] },
  "decision.made": { required: ["decision_type", "option"], optional: ["amount", "reason"] },
  "context.observed": { required: [], optional: [] },
  "outcome.observed": { required: ["outcome_type"], optional: ["value", "polarity"] },
};

// Free-form data field families allowed on generic events (validator and mapping agent).
export const OPEN_FIELDS: Partial<Record<CanonicalType, string[]>> = {
  "decision.proposed": ["context.", "detail."], "decision.made": ["context.", "detail."], "context.observed": ["context."],
};
