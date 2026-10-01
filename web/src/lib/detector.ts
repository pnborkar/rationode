// Contract events -> decision-graph rows. Port of pipeline/src/rationode/pipeline/detect.py, reading
// canonical contract events instead of vendor payloads, so every door (native adapter, uploaded
// files through a mapping, later webhooks and the gateway) shares one detector.
// A pure function of (events, registry, scenario): no database access. Every ID derives from source
// event IDs, so re-running yields the same rows and writes MERGE idempotently.
import type { Actor, ContractEvent } from "./contract";

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;

const POLICIES: Record<string, [string, string]> = {
  "charge.fraud_screen": ["fraud-screening", "2025.1"],
  "support.complaint_resolution": ["streamly-refunds", "2025.1"],
  "dispute.response": ["streamly-disputes", "2025.1"],
  "dispute.evidence": ["streamly-disputes", "2025.1"],
};
const DISPUTE_FEE = 15, CONTEST_FEE = 15;
const AI_FINAL_CONFIDENCE = 0.9;   // AI proposal executed without human action (inferred from ticket closure)
const DAY_MS = 86_400_000;

export type Registry = {
  options: Record<string, Record<string, string>>;   // decision type -> option -> APPROVED | PROPOSED
  windows: Record<string, number>;                   // outcome type -> attribution window (days)
  // A workspace's decision model (§22.1; generic outcomes only): the window for outcome types without one, and
  // good / bad set in Settings over what the data says.
  defaultWindow?: number;
  polarities?: Record<string, "good" | "bad">;
};

// Same query as pipeline/src/rationode/pipeline/write.py load_registry.
export const REGISTRY_CYPHER = `MATCH (s:SchemaElement) WHERE s.kind IN ['OPTION', 'OUTCOME_TYPE']
  RETURN s.kind AS kind, s.key AS key, s.decision_type AS dt, s.status AS status, s.default_window_days AS window`;

export function registryFrom(records: { kind: string; key: string; dt: string; status: string; window: number }[]): Registry {
  const reg: Registry = { options: {}, windows: {} };
  for (const r of records) {
    if (r.kind === "OPTION") (reg.options[r.dt] ??= {})[r.key.slice(r.dt.length + 1)] = r.status;
    else reg.windows[r.key.replace(/^outcome\./, "")] = r.window;
  }
  return reg;
}

export type Rows = {
  events: Row[]; entities: Row[]; same_as: Row[]; actors: Map<string, Row>; decisions: Row[]; contexts: Row[];
  considered: Row[]; made_by: Row[]; about: Row[]; preceded_by: Row[]; overrides: Row[]; under_policy: Row[];
  evidenced_by: Row[]; outcomes: Row[]; led_to: Row[]; schema_proposals: Map<string, Row>;
  links: Row[];   // identity: PAID_WITH, FROM_DEVICE, USED
  review: Row[];
};

// The shape the set files and storyWriter use: actors and proposals as lists, no review queue.
export function rowsDict(r: Rows): Record<string, Row[]> {
  const { actors, schema_proposals, ...rest } = r;
  const out: Record<string, Row[]> = { ...rest, actors: [...actors.values()], schema_proposals: [...schema_proposals.values()] };
  delete out.review;
  return out;
}

// Python's f"{x:.0f}" (round half to even), so summaries match the Python pipeline's text exactly.
function fmt0(x: number): string {
  const f = Math.floor(x), diff = x - f;
  return String(diff > 0.5 || (diff === 0.5 && f % 2 !== 0) ? f + 1 : f);
}

const ms = (iso: string) => Date.parse(iso);

type Proposal = { id: string; option: string; amount: number | null; ctx: Data; actor: string; ticketEntity: string };

export class Detector {
  protected reg: Registry;
  protected scenario: string;
  readonly rows: Rows = {
    events: [], entities: [], same_as: [], actors: new Map(), decisions: [], contexts: [], considered: [], made_by: [],
    about: [], preceded_by: [], overrides: [], under_policy: [], evidenced_by: [], outcomes: [], led_to: [],
    schema_proposals: new Map(), links: [], review: [],
  };
  private entityIds = new Set<string>();
  private byCustomer = new Map<string, [string, string, string][]>();   // cus -> (at, decision_id, kind)
  private chosenRows = new Map<string, Row[]>();                        // decision_id -> CHOSEN/PROPOSED rows

  constructor(registry: Registry, scenario = "history") {
    // The detector marks unseen options PROPOSED as it goes, so it works on its own copy.
    this.reg = { options: Object.fromEntries(Object.entries(registry.options).map(([k, v]) => [k, { ...v }])), windows: { ...registry.windows },
                 defaultWindow: registry.defaultWindow, polarities: registry.polarities };
    this.scenario = scenario;
  }

  // ---------------------------------------------------------- ids and small writers
  pid(value: string): string {
    return this.scenario === "history" ? value : `${this.scenario}|${value}`;
  }

  protected approved(decisionType: string): string[] {
    return Object.entries(this.reg.options[decisionType] ?? {}).filter(([, s]) => s === "APPROVED").map(([k]) => k).sort();
  }

  protected entity(label: string, source: string, key: string, props: Data): string {
    const entityId = this.pid(`${source}:${key}`);
    if (!this.entityIds.has(entityId)) {
      this.entityIds.add(entityId);
      this.rows.entities.push({ entity_id: entityId, label, source_system: source, source_key: key, props, scenario_id: this.scenario });
    }
    return entityId;
  }

  protected actor(a: Actor): string {
    const aid = this.pid(a.id);
    if (!this.rows.actors.has(aid)) {
      this.rows.actors.set(aid, { actor_id: aid, kind: a.kind, version: a.version ?? null, name: a.name ?? null,
                                  team: a.team ?? null, scenario_id: this.scenario });
    }
    return aid;
  }

  protected optionStatus(decisionType: string, option: string, at: string): void {
    const known = (this.reg.options[decisionType] ??= {});
    if (!(option in known)) {
      known[option] = "PROPOSED";
      const key = `${decisionType}.${option}`;
      const display = option.replaceAll("_", " ");
      this.rows.schema_proposals.set(key, { key, decision_type: decisionType, option_key: option, first_seen_at: at,
                                            display_name: display.charAt(0).toUpperCase() + display.slice(1).toLowerCase() });
    }
  }

  protected decision(src: ContractEvent, decisionType: string, stage: string, o: {
    actor: string; role: string; chosen: [string, number | null][]; context: Data; summary: string; about: string[];
    evidence: ContractEvent[]; suffix?: string; confidence?: number; rejected?: string[]; proposedStatus?: boolean;
    allOptions?: string[]; rationale?: string | null; extra?: Row;
  }): string {
    const at = src.occurred_at, suffix = o.suffix ?? "", rejected = o.rejected ?? [];
    const did = this.pid(`dec:${src.event_id}${suffix}`);
    const r = this.rows;
    r.decisions.push({ decision_id: did, decision_type: decisionType, stage, decided_at: at, detection_method: "RULE",
                       detection_confidence: o.confidence ?? 1.0, source_system: src.source, scenario_id: this.scenario,
                       ...(o.rationale ? { rationale: o.rationale } : {}),   // why, when the decider said (a rep's override note)
                       ...(o.extra ?? {}) });
    r.contexts.push({ context_id: this.pid(`ctx:${src.event_id}${suffix}`), decision_id: did, attrs: o.context,
                      summary_text: o.summary, scenario_id: this.scenario });
    const chosenKeys = new Set(o.chosen.map(([k]) => k));
    const mine: Row[] = [];
    this.chosenRows.set(did, mine);
    for (const [option, amount] of o.chosen) {
      this.optionStatus(decisionType, option, at);
      const row = { decision_id: did, decision_type: decisionType, option_key: option,
                    status: o.proposedStatus ? "PROPOSED" : "CHOSEN", amount_usd: amount };
      r.considered.push(row);
      mine.push(row);
    }
    for (const option of rejected) {
      if (!chosenKeys.has(option)) {
        r.considered.push({ decision_id: did, decision_type: decisionType, option_key: option, status: "REJECTED", amount_usd: null });
      }
    }
    for (const option of o.allOptions ?? this.approved(decisionType)) {
      if (!chosenKeys.has(option) && !rejected.includes(option)) {
        r.considered.push({ decision_id: did, decision_type: decisionType, option_key: option, status: "AVAILABLE", amount_usd: null });
      }
    }
    r.made_by.push({ decision_id: did, actor_id: o.actor, role: o.role });
    for (const e of o.about) r.about.push({ decision_id: did, entity_id: e });
    const policy = POLICIES[decisionType];   // generic decision types (§23.8) have no policy until one is declared
    if (policy) r.under_policy.push({ decision_id: did, policy_id: policy[0], version: policy[1] });
    for (const e of o.evidence) r.evidenced_by.push({ node_id: did, kind: "Decision", event_id: this.pid(e.event_id) });
    return did;
  }

  protected outcome(src: ContractEvent, outcomeType: string, value: number | null, extra?: Row): string {
    const oid = this.pid(`out:${src.event_id}`);
    this.rows.outcomes.push({ outcome_id: oid, outcome_type: outcomeType, occurred_at: src.occurred_at, value_usd: value,
                              scenario_id: this.scenario, ...(extra ?? {}) });
    this.rows.evidenced_by.push({ node_id: oid, kind: "Outcome", event_id: this.pid(src.event_id) });
    return oid;
  }

  protected ledTo(decisionId: string | null, outcomeId: string, outcomeType: string, method: string, confidence: number): void {
    if (decisionId) {
      this.rows.led_to.push({ decision_id: decisionId, outcome_id: outcomeId, confidence, attribution_method: method,
                              window_days: this.reg.windows[outcomeType] ?? null });
    }
  }

  // ---------------------------------------------------------- main
  run(events: ContractEvent[]): Rows {
    const evs = [...events].sort((a, b) =>
      a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);
    const ticketCharge = new Map<string, string>(), disputeCharge = new Map<string, string>();
    const emailCus = new Map<string, string>(), cusName = new Map<string, string>();
    for (const e of evs) {
      const x = e.entity_refs;
      if (x.ticket_id && x.charge_id) ticketCharge.set(x.ticket_id, x.charge_id);
      if (x.dispute_id && x.charge_id) disputeCharge.set(x.dispute_id, x.charge_id);
      if (x.stripe_customer_id && x.customer_email) emailCus.set(x.customer_email, x.stripe_customer_id);
      if (e.event_type === "charge.succeeded" && x.stripe_customer_id) cusName.set(x.stripe_customer_id, e.data.name as string);
    }

    const cases = new Map<string, ContractEvent[]>();
    const customerEvents: ContractEvent[] = [];
    const identityEvents: ContractEvent[] = [];
    for (const e of evs) {
      const x = e.entity_refs;
      this.rows.events.push({
        event_id: this.pid(e.event_id), source_system: e.source, event_type: e.source_type, occurred_at: e.occurred_at,
        payload_json: JSON.stringify(e.raw), charge_id: x.charge_id ?? null, ticket_id: x.ticket_id ?? null,
        dispute_id: x.dispute_id ?? null, stripe_customer_id: x.stripe_customer_id ?? null, email: x.customer_email ?? null,
        scenario_id: this.scenario,
        // The contract's view of the event, so readers need not know each vendor's payload shape.
        canonical_type: e.event_type, data_json: JSON.stringify(e.data),
      });
      const charge = x.charge_id || (x.ticket_id && ticketCharge.get(x.ticket_id)) || (x.dispute_id && disputeCharge.get(x.dispute_id));
      if (x.card_fingerprint || x.device_id) identityEvents.push(e);
      if (e.event_type === "charge.identifiers") continue;   // identity only, not part of the case
      if (e.event_type.startsWith("subscription.") || e.event_type === "usage.weekly") {   // customer-level
        customerEvents.push(e);
      } else if (charge) {
        if (!cases.has(charge)) cases.set(charge, []);
        cases.get(charge)!.push(e);
      } else {
        this.rows.review.push({ event_id: e.event_id, reason: "no case key" });
      }
    }

    for (const [chargeId, caseEvents] of cases) this.case(chargeId, caseEvents, emailCus, cusName);
    for (const e of identityEvents) this.identity(e, emailCus);
    this.customerOutcomes(customerEvents);
    return this.rows;
  }

  // ---------------------------------------------------------- identity (card, device) behind a charge
  private identity(e: ContractEvent, emailCus: Map<string, string>): void {
    const x = e.entity_refs;
    const cus = x.stripe_customer_id || (x.customer_email ? emailCus.get(x.customer_email) : undefined);
    if (!(cus && x.charge_id)) {
      this.rows.review.push({ event_id: e.event_id, reason: "identity signals without customer or charge" });
      return;
    }
    const charge = this.pid(`stripe:${x.charge_id}`), customer = this.pid(`stripe:${cus}`);
    const links = this.rows.links, at = e.occurred_at;
    if (x.card_fingerprint) {
      const card = this.entity("Card", "card", x.card_fingerprint, { country: e.data.card_country ?? null });
      links.push({ type: "PAID_WITH", from: charge, to: card, at, ip_country: null });
      links.push({ type: "USED", from: customer, to: card, at, ip_country: null });
    }
    if (x.device_id) {
      const device = this.entity("Device", "device", x.device_id, {});
      links.push({ type: "FROM_DEVICE", from: charge, to: device, at, ip_country: e.data.ip_country ?? null });
      links.push({ type: "USED", from: customer, to: device, at, ip_country: null });
    }
  }

  // ---------------------------------------------------------- one case (one charge)
  private case(chargeId: string, evs: ContractEvent[], emailCus: Map<string, string>, cusName: Map<string, string>): void {
    const screen = evs.find((e) => e.event_type === "charge.screened");
    const email = evs.find((e) => e.entity_refs.customer_email)?.entity_refs.customer_email ?? null;
    const cus = evs.find((e) => e.entity_refs.stripe_customer_id)?.entity_refs.stripe_customer_id
      || (email ? emailCus.get(email) : undefined);
    if (!cus) {
      this.rows.review.push({ case: chargeId, reason: "customer not resolved" });
      return;
    }
    const customer = this.entity("Customer", "stripe", cus, { email, name: cusName.get(cus) ?? null });
    const charge = this.entity("Charge", "stripe", chargeId, {
      amount_usd: screen ? screen.data.amount : null, plan: screen ? screen.data.plan : null });
    const byCus = this.byCustomer.get(cus) ?? [];
    this.byCustomer.set(cus, byCus);

    let screenDec: string | null = null, complaintFinal: string | null = null;
    let proposal: Proposal | null = null;
    let ticket: ContractEvent | null = null, ticketEntity: string | null = null;
    // A charge can have more than one ticket (e.g. a customer writes in again): proposals and final decisions
    // are tracked per ticket; complaintFinal is the latest, for outcomes on the charge.
    const tickets = new Map<string, [ContractEvent, string]>();
    const proposals = new Map<string, Proposal>();
    const finals = new Map<string, string>();
    const sessions = new Map<string, ContractEvent>();
    let disputeEv: ContractEvent | null = null, responseDec: string | null = null, evidenceDec: string | null = null;
    let contested = false;

    for (const e of evs) {
      const d: Data = e.data, x = e.entity_refs;
      switch (e.event_type) {
        case "charge.screened": {
          screenDec = this.decision(e, "charge.fraud_screen", "FINAL", {
            actor: this.actor(e.actor!), role: "DECIDER", chosen: [[d.decision, null]], about: [charge, customer], evidence: [e],
            context: { "charge.risk_score": d.risk_score, "charge.plan": d.plan, "charge.is_renewal": d.is_renewal,
                       "charge.country_match": d.country_match, "charge.card_age_days": d.card_age_days },
            summary: `Charge screening: ${d.is_renewal ? "renewal" : "signup"} on ${d.plan}, $${fmt0(d.amount)}, risk score ` +
                     `${d.risk_score}, card age ${d.card_age_days} days, country ${d.country_match ? "matches" : "does not match"}.`,
          });
          byCus.push([e.occurred_at, screenDec, "screen"]);
          break;
        }
        case "ticket.created": {
          ticket = e;
          ticketEntity = this.entity("Ticket", "zendesk", `ticket:${x.ticket_id}`,
                                     { category: d.category, channel: d.channel, subject: d.subject ?? null });
          tickets.set(x.ticket_id!, [ticket, ticketEntity]);
          const zdUser = this.entity("Customer", "zendesk", `user:${x.customer_email}`, { email: x.customer_email, name: d.name ?? null });
          this.rows.same_as.push({ from: zdUser, to: customer, confidence: 0.98, method: "EMAIL" });
          break;
        }
        case "agent.customer_lookup":
        case "agent.dispute_lookup":
          sessions.set(x.session_id!, e);
          break;
        case "agent.proposal": {
          const info = sessions.get(x.session_id!);
          const tk = (x.ticket_id ? tickets.get(x.ticket_id) : undefined) ?? (ticket ? [ticket, ticketEntity!] as [ContractEvent, string] : undefined);
          if (!(info && tk)) {
            this.rows.review.push({ event_id: e.event_id, reason: "proposal without customer lookup or ticket" });
            break;
          }
          const [pTicket, pTicketEntity] = tk;
          const ctx = complaintContext(info.data, pTicket.data, d);
          const actor = this.actor(e.actor!);
          const amount = (d.amount_usd ?? null) as number | null;
          const id = this.decision(e, "support.complaint_resolution", "PROPOSAL", {
            actor, role: "PROPOSER", chosen: [[d.option, amount]], proposedStatus: true, context: ctx,
            summary: complaintSummary(ctx, `AI ${e.actor!.version} proposed ${d.option}`),
            about: [pTicketEntity, charge, customer], evidence: [pTicket, info, e],
          });
          proposal = { id, option: d.option, amount, ctx, actor, ticketEntity: pTicketEntity };
          proposals.set(x.ticket_id!, proposal);
          this.rows.preceded_by.push({ from: id, to: screenDec });
          break;
        }
        case "rep.decision":
        case "ticket.closed": {
          const proposal = x.ticket_id ? proposals.get(x.ticket_id) : undefined;
          if (!proposal || finals.has(x.ticket_id!)) break;
          const human = e.event_type === "rep.decision";
          if (!human && e.actor?.kind !== "AI_AGENT") break;
          const option: string = human ? d.option : proposal.option;
          const actor = human ? this.actor(e.actor!) : proposal.actor;
          const overridden = option !== proposal.option;
          // The rep's own amount and reason when given (an override); otherwise the proposal's amount if approved.
          const repAmount = human && d.amount_usd != null ? Number(d.amount_usd) : null;
          const reason = human && d.reason ? String(d.reason) : null;
          complaintFinal = this.decision(e, "support.complaint_resolution", "FINAL", {
            actor, role: "DECIDER", chosen: [[option, repAmount ?? (overridden ? null : proposal.amount)]],
            rejected: overridden ? [proposal.option] : [], context: { ...proposal.ctx },
            confidence: human ? 1.0 : AI_FINAL_CONFIDENCE, rationale: reason,
            summary: complaintSummary(proposal.ctx,
              (human ? `${e.actor!.team} rep chose ${option}` : `AI executed ${option}`)
              + (repAmount != null ? ` ($${repAmount})` : "")
              + (overridden ? `, overriding AI proposal ${proposal.option}` : "")
              + (reason ? `. Reason: ${reason}` : "")),
            about: [proposal.ticketEntity, charge, customer], evidence: [e],
          });
          finals.set(x.ticket_id!, complaintFinal);
          this.rows.preceded_by.push({ from: complaintFinal, to: proposal.id });
          if (overridden) this.rows.overrides.push({ from: complaintFinal, to: proposal.id, detected_at: e.occurred_at });
          byCus.push([e.occurred_at, complaintFinal, "complaint"]);
          break;
        }
        case "refund.created": {
          const out = this.outcome(e, "refund_cost", d.amount);
          const final = (x.ticket_id && finals.get(x.ticket_id)) || complaintFinal;   // the ticket the refund names, else the latest
          this.ledTo(final, out, "refund_cost", "EXPLICIT_REF", 1.0);
          for (const row of (final && this.chosenRows.get(final)) || []) row.amount_usd = d.amount;   // executed amount
          break;
        }
        case "dispute.created": {
          disputeEv = e;
          const out = this.outcome(e, "dispute_filed", d.amount);
          this.ledTo(screenDec, out, "dispute_filed", "EXPLICIT_REF", 1.0);
          this.ledTo(complaintFinal, out, "dispute_filed", "EXPLICIT_REF", 1.0);
          break;
        }
        case "agent.dispute_response": {
          if (!disputeEv) break;
          const info = sessions.get(x.session_id!);
          if (!info) {
            this.rows.review.push({ event_id: e.event_id, reason: "dispute response without evidence lookup" });
            break;
          }
          const res: Data = info.data;
          const disputeEntity = this.entity("Dispute", "stripe", disputeEv.entity_refs.dispute_id!,
                                            { category: res.category, amount_usd: res.amount_usd });
          const logs = (res.available_evidence as string[]).includes("usage_logs");
          const ctx = { "dispute.amount_usd": res.amount_usd, "dispute.category": res.category,
                        "dispute.tenure_months": res.tenure_months, "dispute.prior_complaint": res.prior_complaint,
                        "dispute.usage_logs_available": logs };
          const actor = this.actor(e.actor!);
          contested = d.action === "contest";
          const v = e.actor!.version;
          const base = `Dispute (${res.category}), $${fmt0(res.amount_usd)}, tenure ${res.tenure_months} months, ` +
            `${res.prior_complaint ? "after a complaint" : "no prior complaint"}, usage logs ${logs ? "available" : "not available"}`;
          responseDec = this.decision(e, "dispute.response", "FINAL", {
            actor, role: "DECIDER", chosen: [[d.action, null]], context: ctx, summary: `${base}. AI ${v} chose to ${d.action}.`,
            about: [disputeEntity, charge, customer], evidence: [disputeEv, info, e],
          });
          this.rows.preceded_by.push({ from: responseDec, to: complaintFinal || screenDec });
          byCus.push([e.occurred_at, responseDec, "dispute"]);
          if (contested) {
            const chosen = d.evidence as string[];
            evidenceDec = this.decision(e, "dispute.evidence", "FINAL", {
              actor, role: "DECIDER", suffix: ":evidence", chosen: chosen.map((c) => [c, null] as [string, null]),
              allOptions: res.available_evidence, context: { ...ctx },
              summary: `${base}. AI ${v} submitted evidence: ${chosen.join(", ")}.`,
              about: [disputeEntity, charge, customer], evidence: [info, e],
            });
            this.rows.preceded_by.push({ from: evidenceDec, to: responseDec });
          }
          break;
        }
        case "dispute.closed": {
          if (!disputeEv) break;
          const won = d.status === "won";
          const cost = DISPUTE_FEE + (won ? 0 : d.amount + (contested ? CONTEST_FEE : 0));
          const otype = won ? "dispute_won" : "dispute_lost";
          const out = this.outcome(e, otype, Math.round(cost * 100) / 100);
          this.ledTo(responseDec, out, otype, "EXPLICIT_REF", 1.0);
          this.ledTo(evidenceDec, out, otype, "EXPLICIT_REF", 1.0);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------- churn and renewal (same-customer window)
  private customerOutcomes(evs: ContractEvent[]): void {
    for (const e of evs) {
      if (e.event_type !== "subscription.canceled" && e.event_type !== "subscription.renewed") continue;
      const otype = e.event_type === "subscription.canceled" ? "churn" : "renewal";
      const window = (this.reg.windows[otype] ?? 400) * DAY_MS;
      const at = ms(e.occurred_at);
      const prior = (this.byCustomer.get(e.entity_refs.stripe_customer_id ?? "") ?? [])
        .filter(([t]) => ms(t) <= at && at - ms(t) <= window);
      let candidates = prior.filter(([, , kind]) => kind === "complaint" || kind === "dispute").map(([, id]) => id);
      if (!candidates.length) candidates = prior.filter(([, , kind]) => kind === "screen").map(([, id]) => id).slice(-1);
      if (!candidates.length) continue;
      const out = this.outcome(e, otype, null);
      const confidence = candidates.length === 1 ? 1.0 : 0.6;
      for (const id of candidates) this.ledTo(id, out, otype, "SAME_ENTITY_WINDOW", confidence);
    }
  }
}

function complaintContext(res: Data, ticket: Data, proposal: Data): Data {
  // The ticket's tag, or (live chats have none yet) the category the agent tagged when proposing.
  return { "support.tenure_months": res.tenure_months, "support.plan": res.plan, "support.amount_usd": res.charge_amount_usd,
           "support.complaint_category": ticket.category || proposal.category || null, "support.prior_refunds_90d": res.prior_refunds_90d,
           "support.channel": ticket.channel };
}

function complaintSummary(ctx: Data, what: string): string {
  return `Complaint (${ctx["support.complaint_category"]}) via ${ctx["support.channel"]}: customer tenure ` +
    `${ctx["support.tenure_months"]} months on ${ctx["support.plan"]}, $${fmt0(ctx["support.amount_usd"])} ` +
    `charge, ${ctx["support.prior_refunds_90d"]} refunds in last 90 days. ${what}.`;
}
