// Deterministic checks on a proposed mapping before anything is written (demo spec §16.2):
// columns exist, every row is accounted for, required contract fields are present, timestamps
// parse, option values are known (or will be PROPOSED), references resolve across files, and a
// dry run through the real detector shows what the files would become.
import { DATA_FIELDS, ENTITY_REFS, OPEN_FIELDS, type CanonicalType, type ContractEvent } from "./contract";
import { rowsDict, type Registry } from "./detector";
import { detectAll } from "./genericDetector";
import { mapFile, type FileMapping, type MappedEvent, type ParsedFile, type RowProblem } from "./mapping";

// Entity references each event type needs for the detector to place it.
const REFS_REQUIRED: Record<CanonicalType, string[]> = {
  "charge.screened": ["charge_id", "customer_email"],
  "charge.identifiers": ["charge_id"],
  "charge.succeeded": ["charge_id", "stripe_customer_id", "customer_email"],
  "refund.created": ["charge_id"],
  "dispute.created": ["dispute_id", "charge_id"],
  "dispute.closed": ["dispute_id", "charge_id"],
  "ticket.created": ["ticket_id", "customer_email", "charge_id"],
  "rep.decision": ["ticket_id"],
  "ticket.closed": ["ticket_id"],
  "agent.customer_lookup": ["session_id", "ticket_id", "charge_id"],
  "agent.proposal": ["session_id", "ticket_id"],
  "agent.dispute_lookup": ["session_id", "dispute_id", "charge_id"],
  "agent.dispute_response": ["session_id", "dispute_id"],
  "agent.tool_call": ["session_id"],
  "subscription.created": ["stripe_customer_id"],
  "subscription.renewed": ["stripe_customer_id"],
  "subscription.canceled": ["stripe_customer_id"],
  "subscription.paused": ["stripe_customer_id"],
  "usage.weekly": ["stripe_customer_id"],
  // Generic decision events (§23.8): every one is about a subject.
  "decision.proposed": ["subject_type", "subject_id"], "decision.made": ["subject_type", "subject_id"],
  "context.observed": ["subject_type", "subject_id"], "outcome.observed": ["subject_type", "subject_id"],
};
const ACTOR_REQUIRED: CanonicalType[] = ["rep.decision", "ticket.closed", "agent.proposal", "agent.dispute_response", "charge.screened"];

// Which data field holds an option for which decision type.
const OPTION_FIELDS: { type: CanonicalType; field: string; decisionType: string }[] = [
  { type: "charge.screened", field: "decision", decisionType: "charge.fraud_screen" },
  { type: "agent.proposal", field: "option", decisionType: "support.complaint_resolution" },
  { type: "rep.decision", field: "option", decisionType: "support.complaint_resolution" },
  { type: "agent.dispute_response", field: "action", decisionType: "dispute.response" },
  { type: "agent.dispute_response", field: "evidence", decisionType: "dispute.evidence" },
  { type: "agent.dispute_lookup", field: "available_evidence", decisionType: "dispute.evidence" },
];

// fix: a mapping change the reviewer can apply with one click (the mapping editor, §23.8): link a subject type to
// another system's subjects (refs.subject_system / refs.parent_system).
export type CheckFix = { kind: "subject_system"; type: string; system: string };
export type Check = { level: "ok" | "warn" | "error"; file?: string; message: string; examples?: string[]; fix?: CheckFix };

export type FileReport = {
  file: string; rows: number; events: number; skipped: number; unmatched: number;
  byRecord: { record: string; event_type: string; count: number }[];
  checks: Check[];
};

export type Validation = {
  ok: boolean;                       // no errors
  files: FileReport[];
  checks: Check[];                   // cross-file checks
  dryRun: {
    events: number; decisions: { decision_type: string; stage: string; count: number }[];
    outcomes: { outcome_type: string; count: number }[]; windows?: Record<string, number>; overrides: number; identityLinks: number;
    customers: number; schemaProposals: string[]; review: { reason: string; count: number }[];
    preview: { decision_id: string; decision_type: string; stage: string; summary: string; outcomes: string[] }[];
  };
  events: ContractEvent[];
  // Set by the upload layer when these records are already loaded: the batch (or workspace source) they update and what differs.
  // A workspace update that would remove most of a source's records (probably the wrong source name): approving needs
  // an explicit confirmation (§23.9).
  removal?: { source: string; removed: number; total: number; files: string[] };
  // remapped: the records are unchanged but the mapping differs from the source's approved one (§23.11 gap): approving
  // re-interprets them. reused: the mapping is the source's approved one, unchanged.
  target?: { scenario: string; source?: string; remapped?: boolean; reused?: boolean; approvedAt?: string | null; new: number; changed: number; unchanged: number; removed: number; examples: string[] };
};

const counted = <T,>(items: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].map(([k, count]) => ({ k, count }));
};

// context: the workspace's other sources' events (§23.9), detected together with these so the dry run sees what a load
// would see (e.g. an outcome credited to another source's decision, §23.11); the report covers only these files.
export function validate(files: ParsedFile[], mappings: FileMapping[], registry: Registry, scenario: string,
                         context: ContractEvent[] = []): Validation {
  const reports: FileReport[] = [];
  const all: MappedEvent[] = [];
  for (const f of files) {
    const m = mappings.find((x) => x.file === f.name);
    if (!m) {
      reports.push({ file: f.name, rows: f.rows.length, events: 0, skipped: 0, unmatched: f.rows.length, byRecord: [],
                     checks: [{ level: "error", message: "No mapping for this file" }] });
      continue;
    }
    const checks: Check[] = [];
    // Columns the mapping refers to must exist.
    const used = new Set<string>();
    for (const r of m.records) {
      if (r.when) used.add(r.when.column);
      for (const fm of r.fields) {
        if (fm.column) used.add(fm.column);
        for (const [, c] of (fm.template ?? "").matchAll(/\{([^}]+)\}/g)) used.add(c);
      }
    }
    const missing = [...used].filter((c) => !f.columns.includes(c));
    if (missing.length) checks.push({ level: "error", message: `Columns not in the file: ${missing.join(", ")}` });
    // Targets must be contract fields for their event type.
    for (const r of m.records) {
      const allowed = new Set(["event_id", "occurred_at", "received_at",
        ...ENTITY_REFS.map((x) => `refs.${x}`),
        ...["kind", "id", "name", "team", "version"].map((x) => `actor.${x}`),
        ...[...DATA_FIELDS[r.event_type].required, ...(DATA_FIELDS[r.event_type].optional ?? [])].map((x) => `data.${x}`)]);
      const open = OPEN_FIELDS[r.event_type] ?? [];   // generic events: data.context.<name>, data.detail.<name>
      const bad = r.fields.filter((fm) => !allowed.has(fm.target) && !open.some((p) => fm.target.startsWith(`data.${p}`) && fm.target.length > p.length + 5))
        .map((fm) => fm.target);
      if (bad.length) checks.push({ level: "error", message: `${r.name}: not contract fields for ${r.event_type}: ${bad.join(", ")}` });
      const n = f.rows.filter((row) => !r.when || String(row[r.when.column] ?? "").trim() === r.when.equals).length;
      if (!n) checks.push({ level: "warn", message: `${r.name}: the filter matches no rows` });
    }

    const { events, problems, skipped, unmatched } = mapFile(f, m);
    all.push(...events);
    if (problems.length) checks.push(problemCheck(problems));
    if (unmatched) {
      const col = m.records.find((r) => r.when)?.when?.column;
      const values = col ? [...new Set(f.rows.filter((row) => !m.records.some((r) => !r.when || String(row[r.when.column] ?? "").trim() === r.when.equals)
                                                          && !m.skipped.some((s) => String(row[s.when.column] ?? "").trim() === s.when.equals))
                                             .map((row) => String(row[col])))] : [];
      checks.push({ level: "warn", message: `${unmatched} rows match no record type and are not skipped`, examples: values.slice(0, 5) });
    }

    // Per-event contract checks.
    const missingField = new Map<string, { count: number; examples: string[] }>();
    const note = (k: string, ex: string) => {
      const m = missingField.get(k) ?? { count: 0, examples: [] };
      m.count++;
      if (m.examples.length < 3) m.examples.push(ex);
      missingField.set(k, m);
    };
    for (const { event: e, row, record } of events) {
      if (!e.event_id) note(`${record}: event_id is empty`, `row ${row}`);
      if (!e.occurred_at) note(`${record}: occurred_at is empty or not a timestamp`, `row ${row}`);
      for (const d of DATA_FIELDS[e.event_type].required) {
        const v = e.data[d];
        if (v === null || v === undefined || v === "") note(`${record}: data.${d} is missing`, `row ${row}`);
      }
      for (const ref of REFS_REQUIRED[e.event_type]) {
        if (!(e.entity_refs as Record<string, unknown>)[ref]) note(`${record}: refs.${ref} is missing`, `row ${row}`);
      }
      if (ACTOR_REQUIRED.includes(e.event_type) && !e.actor?.id) note(`${record}: actor is missing`, `row ${row}`);
      if (e.event_type === "context.observed" && !Object.keys(e.data).some((k) => k.startsWith("context."))) {
        note(`${record}: no data.context.* facts`, `row ${row}`);
      }
    }
    for (const [message, { count, examples }] of missingField) {
      checks.push({ level: "error", message: `${message} in ${count} rows`, examples });
    }
    if (!checks.some((c) => c.level === "error")) {
      checks.unshift({ level: "ok", message: `${events.length} events from ${f.rows.length} rows` + (skipped ? ` (${skipped} skipped on purpose)` : "") });
    }
    reports.push({
      file: f.name, rows: f.rows.length, events: events.length, skipped, unmatched,
      byRecord: counted(events, (x) => `${x.record}\u0000${x.event.event_type}`).map(({ k, count }) => {
        const [record, event_type] = k.split("\u0000");
        return { record, event_type, count };
      }),
      checks,
    });
  }

  // ---------------------------------------------------------- cross-file checks
  const checks: Check[] = [];
  const evs = all.map((x) => x.event);
  const dup = counted(evs, (e) => e.event_id).filter((x) => x.count > 1 && x.k);
  if (dup.length) checks.push({ level: "error", message: `${dup.length} event IDs appear more than once`, examples: dup.slice(0, 3).map((d) => d.k) });

  const ids = (type: CanonicalType[], ref: keyof ContractEvent["entity_refs"]) =>
    new Set(evs.filter((e) => type.includes(e.event_type)).map((e) => e.entity_refs[ref]).filter(Boolean) as string[]);
  const charges = ids(["charge.succeeded", "charge.screened"], "charge_id");
  const tickets = ids(["ticket.created"], "ticket_id");
  const disputes = ids(["dispute.created"], "dispute_id");
  const customers = ids(["charge.succeeded"], "stripe_customer_id");
  const refCheck = (label: string, types: CanonicalType[], ref: keyof ContractEvent["entity_refs"], known: Set<string>, what: string) => {
    const refs = evs.filter((e) => types.includes(e.event_type) && e.entity_refs[ref]).map((e) => e.entity_refs[ref] as string);
    if (!refs.length) return;
    const unresolved = refs.filter((r) => !known.has(r));
    checks.push(unresolved.length
      ? { level: "warn", message: `${label}: ${unresolved.length} of ${refs.length} ${ref} values not found in ${what}`, examples: unresolved.slice(0, 3) }
      : { level: "ok", message: `${label}: all ${refs.length} ${ref} values found in ${what}` });
  };
  refCheck("Tickets → charges", ["ticket.created"], "charge_id", charges, "the payments or screening file");
  refCheck("Rep decisions → tickets", ["rep.decision", "ticket.closed"], "ticket_id", tickets, "ticket creations");
  refCheck("Refunds → charges", ["refund.created"], "charge_id", charges, "payments");
  refCheck("Disputes → charges", ["dispute.created", "dispute.closed"], "charge_id", charges, "payments");
  refCheck("Agent lookups → tickets", ["agent.customer_lookup", "agent.proposal"], "ticket_id", tickets, "ticket creations");
  refCheck("Agent dispute calls → disputes", ["agent.dispute_lookup", "agent.dispute_response"], "dispute_id", disputes, "disputes");
  refCheck("Usage → customers", ["usage.weekly"], "stripe_customer_id", customers, "payments");
  refCheck("Subscriptions → customers", ["subscription.created", "subscription.renewed", "subscription.canceled", "subscription.paused"],
           "stripe_customer_id", customers, "payments");
  const lookups = new Set(evs.filter((e) => e.event_type.endsWith("_lookup")).map((e) => e.entity_refs.session_id));
  const orphans = evs.filter((e) => (e.event_type === "agent.proposal" || e.event_type === "agent.dispute_response") && !lookups.has(e.entity_refs.session_id));
  if (evs.some((e) => e.event_type === "agent.proposal" || e.event_type === "agent.dispute_response")) {
    checks.push(orphans.length
      ? { level: "warn", message: `${orphans.length} agent decisions have no lookup in the same session`, examples: orphans.slice(0, 3).map((e) => e.event_id) }
      : { level: "ok", message: "Every agent decision has a lookup in the same session" });
  }
  // Option values against the schema registry.
  for (const o of OPTION_FIELDS) {
    const values = evs.filter((e) => e.event_type === o.type).flatMap((e) => {
      const v = e.data[o.field];
      return Array.isArray(v) ? v.map(String) : v === null || v === undefined ? ["(empty)"] : [String(v)];
    });
    if (!values.length) continue;
    const known = registry.options[o.decisionType] ?? {};
    const byValue = counted(values, (v) => v);
    const empty = byValue.find((x) => x.k === "(empty)");
    const unknown = byValue.filter((x) => x.k !== "(empty)" && !(x.k in known));
    const proposed = byValue.filter((x) => known[x.k] === "PROPOSED");
    if (empty) checks.push({ level: "error", message: `${o.type} ${o.field}: ${empty.count} values did not map to an option` });
    if (unknown.length) checks.push({ level: "warn", message: `${o.type} ${o.field}: new options, will be PROPOSED in the schema registry`,
                                      examples: unknown.map((x) => `${x.k} (${x.count})`) });
    const approved = byValue.filter((x) => known[x.k] === "APPROVED");
    if (approved.length || proposed.length) {
      checks.push({ level: "ok", message: `${o.type} ${o.field}: ` + [...approved, ...proposed]
        .map((x) => `${x.k}${known[x.k] === "PROPOSED" ? " (proposed)" : ""} ×${x.count}`).join(", ") });
    }
  }

  // Generic decisions (§23.8): decision types and options first seen here will be PROPOSED in the schema registry.
  const generic = evs.filter((e) => e.event_type === "decision.made" || e.event_type === "decision.proposed");
  for (const [type, list] of [...new Map(generic.map((e) => [String(e.data.decision_type ?? ""), [] as ContractEvent[]])).keys()]
         .map((t) => [t, generic.filter((e) => String(e.data.decision_type ?? "") === t)] as const)) {
    if (!type) continue;
    const known = registry.options[type];
    const byOption = counted(list, (e) => String(e.data.option ?? "(empty)"));
    checks.push({ level: known ? "ok" : "warn",
                  message: `${type}: ${known ? "" : "new decision type (PROPOSED), "}options ` + byOption.map((x) => `${x.k} ×${x.count}`).join(", ") });
  }

  // ---------------------------------------------------------- dry run through the real detectors
  const focus = context.length ? new Set(evs.map((e) => e.event_id)) : undefined;
  const { rows, notes } = detectAll(registry, scenario, focus ? [...context.filter((e) => !focus.has(e.event_id)), ...evs] : evs, focus);
  if (notes) {   // every default the generic detector applied, shown before approval (§23.8)
    if (notes.defaultedActors) checks.push({ level: "warn", message: `Actor defaulted to SYSTEM (the source) for ${notes.defaultedActors} decisions: no actor mapped` });
    const pol = Object.entries(notes.unknownPolarity);
    if (pol.length) checks.push({ level: "warn", message: "Outcome polarity unknown (set good / bad in the mapping)", examples: pol.map(([t, n]) => `${t} ×${n}`) });
    if (notes.laterFactsExcluded) checks.push({ level: "ok", message: `${notes.laterFactsExcluded} facts observed after a decision kept out of its context (no future information)` });
    // Outcome windows (§23.11): what was credited late, and what wasn't credited and why.
    for (const [t, c] of Object.entries(notes.creditedOutsideWindow)) {
      checks.push({ level: "ok", message: `${c.n} ${t} outcome(s) came later than the ${c.window}-day window (up to ${c.maxDays} days after) ` +
        `and are credited to the only decision about their subject (marked "outside the window").` });
    }
    for (const [t, l] of Object.entries(notes.lateOutcomes)) {
      checks.push({ level: "warn", message: `${l.n} ${t} outcome(s) came after the ${l.window}-day window (the nearest earlier decision ` +
        `${l.minDays}+ days before) and the choice isn't clear (several decisions about the subject, or decisions only about related ` +
        `subjects: its parent or the things that belong to it), so they're credited to no decision. Is the window too short for ${t}? Set it under "Outcome windows" and validate again.`, examples: l.examples });
    }
    if (notes.noDecisionBefore) checks.push({ level: "warn", message: `${notes.noDecisionBefore} outcome(s) have no decision about ` +
      `their subject (or its parent or children) before them: kept on the subject, credited to no decision.` });
    for (const [t, n] of Object.entries(notes.conflicting)) {
      checks.push({ level: "warn", message: `${t}: ${n} subjects have final decisions with different options. Is each really a choice, ` +
                                            "or is one of them a state every case passes through?" });
    }
  }
  const allRows = rowsDict(rows);
  // With context, report what these files bring: their decisions and outcomes, and the credit links touching them.
  const pid = (id: string) => (scenario === "history" ? id : `${scenario}|${id}`);
  const mine = focus ? new Set([...focus].map(pid)) : null;
  const evidenced = (kind: string) => new Set(allRows.evidenced_by.filter((x) => x.kind === kind && (!mine || mine.has(x.event_id as string))).map((x) => x.node_id as string));
  const myDecisions = evidenced("Decision"), myOutcomes = evidenced("Outcome");
  const dict = !mine ? allRows : {
    ...allRows,
    decisions: allRows.decisions.filter((x) => myDecisions.has(x.decision_id as string)),
    outcomes: allRows.outcomes.filter((x) => myOutcomes.has(x.outcome_id as string)),
    led_to: allRows.led_to.filter((x) => myDecisions.has(x.decision_id as string) || myOutcomes.has(x.outcome_id as string)),
    overrides: allRows.overrides.filter((x) => myDecisions.has(x.from as string) || myDecisions.has(x.to as string)),
    contexts: allRows.contexts, schema_proposals: allRows.schema_proposals,
  };
  const ctx = new Map(dict.contexts.map((c) => [c.decision_id as string, c.summary_text as string]));
  const outType = new Map(dict.outcomes.map((o) => [o.outcome_id as string, o.outcome_type as string]));
  const outcomesBy = new Map<string, string[]>();
  for (const l of dict.led_to) (outcomesBy.get(l.decision_id as string) ?? outcomesBy.set(l.decision_id as string, []).get(l.decision_id as string)!).push(outType.get(l.outcome_id as string) ?? "");
  const outcomesOf = (id: string) => outcomesBy.get(id) ?? [];
  // Preview: these files' decisions, and (with context) other sources' decisions their outcomes are credited to.
  const credited = new Set(dict.led_to.map((l) => l.decision_id as string));
  const finals = (mine ? allRows.decisions.filter((d) => myDecisions.has(d.decision_id as string) || credited.has(d.decision_id as string)) : dict.decisions)
    .filter((d) => d.stage === "FINAL" && d.decision_type !== "charge.fraud_screen");
  // Six examples, those with outcomes first (picked without scanning everything twice: event logs are large).
  const withOutcomes = finals.filter((d) => outcomesBy.has(d.decision_id as string)).slice(0, 6);
  const preview = [...withOutcomes, ...finals.filter((d) => !withOutcomes.includes(d)).slice(0, 6 - withOutcomes.length)]
    .map((d) => ({ decision_id: d.decision_id as string, decision_type: d.decision_type as string, stage: d.stage as string,
                   summary: ctx.get(d.decision_id as string) ?? "", outcomes: outcomesOf(d.decision_id as string) }));

  const errors = [...reports.flatMap((r) => r.checks), ...checks].some((c) => c.level === "error");
  return {
    ok: !errors && evs.length > 0, files: reports, checks,
    dryRun: {
      events: evs.length,
      decisions: counted(dict.decisions, (d) => `${d.decision_type}\u0000${d.stage}`).map(({ k, count }) => {
        const [decision_type, stage] = k.split("\u0000");
        return { decision_type, stage, count };
      }),
      outcomes: counted(dict.outcomes, (o) => o.outcome_type as string).map(({ k, count }) => ({ outcome_type: k, count })),
      // Each outcome type's window as used in this dry run (the registry's, or 90 days), for the editor.
      windows: Object.fromEntries([...new Set(dict.outcomes.map((o) => o.outcome_type as string))].map((t) => [t, registry.windows[t] ?? registry.defaultWindow ?? 90])),
      overrides: dict.overrides.length, identityLinks: dict.same_as.length,
      customers: new Set(dict.entities.filter((e) => e.label === "Customer" && e.source_system === "stripe").map((e) => e.entity_id)).size,
      schemaProposals: dict.schema_proposals.map((s) => s.key as string),
      review: counted(rows.review, (r) => r.reason as string).map(({ k, count }) => ({ reason: k, count })),
      preview,
    },
    events: evs,
  };
}

function problemCheck(problems: RowProblem[]): Check {
  const byTarget = counted(problems, (p) => `${p.record} · ${p.target}: ${p.message.replace(/"[^"]*"/, "…")}`);
  return { level: "error", message: `${problems.length} values could not be converted`,
           examples: byTarget.slice(0, 4).map((x) => `${x.k} (${x.count})`) };
}
