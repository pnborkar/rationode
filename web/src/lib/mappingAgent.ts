// The mapping agent (demo spec §16.2): Claude reads one uploaded file's columns, sample rows, and
// distinct values, plus the event contract and the schema registry, and proposes a mapping with a
// one-line reason per field. Structured output, so the result is schema-checked; a person reviews
// it and the deterministic validator checks it before anything runs.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AGENT_MODEL } from "./agent";
import { DATA_FIELDS, ENTITY_REFS } from "./contract";
import type { Registry } from "./detector";
import { FileMappingSchema, profile, type FileMapping, type ParsedFile } from "./mapping";

const client = new Anthropic();

// Meaning of each canonical event type and its data fields: the contract, stated once.
const EVENT_TYPES = `
charge.screened        a fraud/risk tool screened a card charge. data: decision (the tool's verdict: an option of charge.fraud_screen), risk_score, amount (USD), plan, is_renewal (bool), country_match (bool), card_age_days, rule_id, card_country, ip_country. If the row carries identity signals, also map refs.card_fingerprint (the card's fingerprint) and refs.device_id (device)
charge.identifiers     identity signals for a charge recorded separately (card fingerprint, device, countries). refs: charge_id, card_fingerprint, device_id; data: card_country, ip_country
charge.succeeded       a payment went through. data: amount (USD), name (cardholder/customer name), plan
refund.created         money returned on a charge. data: amount (USD), initiated_by (who issued it). refs.ticket_id if the refund names a support ticket
dispute.created        a chargeback was opened. data: amount (USD), category (dispute category), status
dispute.closed         a chargeback was decided. data: amount (USD), status (won | lost), category
ticket.created         a customer opened a support ticket. data: category (the complaint category, e.g. from a tag), channel, subject, name (requester's name)
rep.decision           a human support rep applied a resolution to a ticket (e.g. a macro). data: option (an option of support.complaint_resolution), macro (its label). actor = the rep
ticket.closed          a ticket was solved/closed. Only status changes to solved/closed; other status changes are skipped. actor = who closed it (kind AI_AGENT when it is the AI agent's account, else HUMAN)
agent.customer_lookup  the AI support agent looked up the customer for a ticket. data: tenure_months, plan, charge_amount_usd, prior_refunds_90d
agent.proposal         the AI support agent proposed a resolution. data: option (an option of support.complaint_resolution), amount_usd
agent.dispute_lookup   the AI agent fetched dispute evidence. data: category, amount_usd, tenure_months, prior_complaint (bool), available_evidence (list)
agent.dispute_response the AI agent responded to a dispute. data: action (accept | contest), evidence (list of evidence types submitted)
subscription.created / subscription.renewed / subscription.canceled / subscription.paused   subscription lifecycle. data: plan, started_at, reason
usage.weekly           weekly product usage for a customer. data: week_start, hours_watched, titles_watched`;

function system(registry: Registry): string {
  const options = Object.entries(registry.options)
    .map(([t, o]) => `${t}: ${Object.entries(o).map(([k, s]) => (s === "APPROVED" ? k : `${k} (proposed)`)).join(", ")}`).join("\n");
  const fields = Object.entries(DATA_FIELDS)
    .map(([t, f]) => `${t}: required ${f.required.join(", ") || "none"}${f.optional?.length ? `; optional ${f.optional.join(", ")}` : ""}`).join("\n");
  return `You map a merchant's exported files onto Rationode's event contract. Rationode observes decisions made by AI agents, humans, and systems (fraud screening, complaint resolutions, dispute responses) and their outcomes, and builds a decision graph in Neo4j. You do not detect decisions yourself: you only say how each row becomes a contract event; a deterministic detector does the rest.

Contract event fields (targets):
- event_id: the row's own unique ID (use the source's event/audit/row ID column; a template only if there is none)
- occurred_at: when it happened (transform timestamp; columns without a zone are UTC)
- refs.<ref> for ${ENTITY_REFS.join(", ")}. These are how events from different files join up, so map every reference the row carries (e.g. a refund row's charge ID and ticket ID, a ticket's charge ID custom field, an agent call's conversation/session ID)
- actor.kind (HUMAN | AI_AGENT | SYSTEM), actor.id, actor.name, actor.team, actor.version for events made by someone. Namespace actor IDs by source: humans "<source>:<their id>" (e.g. zendesk:{Updater ID}); AI agents "agent:{agent id}:{version}" with name "<agent name> {version}"; systems "system:<tool name>"
- data.<field> per event type

Canonical event types:
${EVENT_TYPES}

Data fields per type:
${fields}

Schema registry (known options per decision type):
${options}
Known dispute categories: subscription_canceled, not_recognized, unauthorized, duplicate_charge.

Rules:
- One record type per kind of row. If the file mixes kinds, filter with "when" on the column that says what the row is (use the distinct values given). Put row kinds the detector has no use for in "skipped" with a reason.
- Every option value must come out as a registry option key. Use aliases to translate labels (e.g. a macro title "Refund: full" -> full_refund; "APPROVE" -> approve; a card-network reason "fraudulent" -> unauthorized). List an alias for every distinct value you saw. A label that matches no registry option gets a new snake_case key (it will be PROPOSED for review).
- Amounts in USD as numbers (transform number). Yes/no columns: transform boolean. Lists: transform list.
- Set exactly one of column, template, value on each field; the others null. aliases [] when none; otherwise null unless needed (e.g. actor.kind: alias the AI agent's account to AI_AGENT, otherwise HUMAN).
- Only map columns that exist. Do not invent data. If a required field has no column, leave it out and say so in the file's reason.
- Reasons: one short line each, specific to the evidence (column name, sample values).`;
}

export async function proposeMapping(file: ParsedFile, registry: Registry): Promise<FileMapping> {
  const p = profile(file);
  const response = await client.messages.parse({
    model: AGENT_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(FileMappingSchema) },
    system: system(registry),
    messages: [{
      role: "user",
      content: `Propose the mapping for this file.\n\n${JSON.stringify(p, null, 1)}`,
    }],
  });
  const mapping = response.parsed_output;
  if (!mapping) throw new Error(`The mapping agent returned no valid mapping (stop reason: ${response.stop_reason})`);
  return { ...mapping, file: file.name };
}
