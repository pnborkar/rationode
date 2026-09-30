// The generic detector (demo spec §23.8): generic decision events (decision.proposed, decision.made,
// context.observed, outcome.observed) from any domain -> the core decision-graph rows, with no domain pack and no
// domain-specific code. The rules (and the defaults when the data doesn't say) are the ones agreed in §23.8:
// refuse rather than guess on the essentials, default and warn where recoverable, no future information in
// context, outcomes only after their decision, explicit references before inference. Reuses the Streamly
// detector's writers (entities, actors, options, decisions, outcomes, links), so the rows have the same shape.
import { isGeneric, type Actor, type ContractEvent } from "./contract";
import { Detector, type Registry, type Rows } from "./detector";

type Row = Record<string, unknown>;
const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 90;   // outcome window when the registry has none for the outcome type
const ms = (iso: string) => Date.parse(iso);

// Labels come from customer data and are written into Cypher, so only letters and digits, PascalCase, and never a
// core node label (a subject called "decision" must not become a Decision node).
const CORE = new Set(["Decision", "Event", "Outcome", "Context", "Actor", "Option", "Policy", "Entity", "DecisionType",
                      "DecisionTree", "DecisionPoint", "SchemaElement", "SchemaChange", "Mapping", "UploadBatch", "Role"]);
export function safeLabel(type: string): string {
  const label = String(type).split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(label)) return "Subject";
  return CORE.has(label) ? `${label}Subject` : label;
}
const snake = (s: string) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const typeKey = (s: string) => String(s).trim().toLowerCase().replace(/[^a-z0-9.]+/g, "_").replace(/^[_.]+|[_.]+$/g, "");
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const value = (v: unknown) => (num(v) ?? v);   // numbers as numbers, the rest as they are

type Fact = { at: string; key: string; value: unknown };
type Dec = { id: string; at: string; type: string; stage: string; option: string; subject: string; parent: string | null; sourceId: string };

export type GenericNotes = {
  defaultedActors: number;                 // decisions with no actor: SYSTEM "<source>"
  unknownPolarity: Record<string, number>; // outcome type -> outcomes with no polarity
  laterFactsExcluded: number;              // facts observed after a decision, kept out of its context
  unlinkedOutcomes: number;                // outcomes with no decision before them in the window
  missingSubject: number;                  // generic events without a subject (not placed)
  conflicting: Record<string, number>;     // decision type -> subjects with FINAL decisions of different options (a real choice?)
};

export class GenericDetector extends Detector {
  readonly notes: GenericNotes = { defaultedActors: 0, unknownPolarity: {}, laterFactsExcluded: 0, unlinkedOutcomes: 0, missingSubject: 0,
                                   conflicting: {} };

  runGeneric(events: ContractEvent[]): Rows {
    const evs = [...events].sort((a, b) =>
      a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);
    const facts = new Map<string, Fact[]>();          // subject entity -> facts over time
    const decisions: Dec[] = [];
    const bySource = new Map<string, Dec>();          // source record ID -> decision (for follows_id)
    const subjectOf = (e: ContractEvent) => {
      const x = e.entity_refs;
      if (!x.subject_type || !x.subject_id) return null;
      const subject = this.entity(safeLabel(x.subject_type), e.source, `${snake(x.subject_type)}:${x.subject_id}`, { subject_type: x.subject_type });
      let parent: string | null = null;
      if (x.parent_type && x.parent_id) {
        parent = this.entity(safeLabel(x.parent_type), e.source, `${snake(x.parent_type)}:${x.parent_id}`, { subject_type: x.parent_type });
        if (!this.rows.links.some((l) => l.type === "PART_OF" && l.from === subject)) this.rows.links.push({ type: "PART_OF", from: subject, to: parent });
      }
      return { subject, parent };
    };
    const addFacts = (subject: string, at: string, data: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(data)) {
        if (!k.startsWith("context.") || v === null || v === undefined || v === "") continue;
        (facts.get(subject) ?? facts.set(subject, []).get(subject)!).push({ at, key: snake(k.slice(8)), value: value(v) });
      }
    };

    for (const e of evs) {
      if (!isGeneric(e.event_type)) continue;
      const x = e.entity_refs, d = e.data;
      this.rows.events.push({
        event_id: this.pid(e.event_id), source_system: e.source, event_type: e.source_type, occurred_at: e.occurred_at,
        payload_json: JSON.stringify(e.raw), charge_id: null, ticket_id: null, dispute_id: null, stripe_customer_id: null, email: null,
        scenario_id: this.scenario, canonical_type: e.event_type, data_json: JSON.stringify(d),
      });
      const s = subjectOf(e);
      if (!s) { this.notes.missingSubject++; this.rows.review.push({ event_id: e.event_id, reason: "generic event without a subject" }); continue; }

      if (e.event_type === "context.observed") { addFacts(s.subject, e.occurred_at, d); continue; }

      if (e.event_type === "decision.proposed" || e.event_type === "decision.made") {
        addFacts(s.subject, e.occurred_at, d);   // facts on the decision's own row are known at that moment
        const type = typeKey(String(d.decision_type ?? "")), option = snake(String(d.option ?? ""));
        if (!type || !option) { this.rows.review.push({ event_id: e.event_id, reason: "decision without type or option" }); continue; }
        const stage = e.event_type === "decision.made" ? "FINAL" : "PROPOSAL";
        let actorDef: Actor | null | undefined = e.actor;
        if (!actorDef?.id) { actorDef = { kind: "SYSTEM", id: `system:${e.source}`, name: e.source }; this.notes.defaultedActors++; }
        const actor = this.actor(actorDef);
        // Context: the latest value of each fact about the subject (and its parent) at or before the decision.
        const ctx: Record<string, unknown> = {};
        const family = type.split(".")[0];
        for (const who of [s.parent, s.subject].filter(Boolean) as string[]) {
          for (const f of facts.get(who) ?? []) {
            if (ms(f.at) > ms(e.occurred_at)) { this.notes.laterFactsExcluded++; continue; }
            ctx[`${family}.${f.key}`] = f.value;
          }
        }
        const amount = num(d.amount);
        const details = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith("detail.")).map(([k, v]) => [snake(k.slice(7)), value(v)]));
        // Proposal -> final: the proposal it names, else the latest proposal of the same type about the same subject.
        let proposal: Dec | undefined;
        if (stage === "FINAL") {
          proposal = (x.follows_id && bySource.get(x.follows_id)) || undefined;
          proposal ??= [...decisions].reverse().find((p) => p.stage === "PROPOSAL" && p.type === type && p.subject === s.subject && ms(p.at) <= ms(e.occurred_at));
        }
        const overridden = !!proposal && proposal.option !== option;
        const facts8 = Object.entries(ctx).slice(0, 8).map(([k, v]) => `${k.slice(family.length + 1).replaceAll("_", " ")} ${v}`).join(", ");
        const id = this.decision(e, type, stage, {
          actor, role: stage === "FINAL" ? "DECIDER" : "PROPOSER", chosen: [[option, amount]], proposedStatus: stage === "PROPOSAL",
          rejected: overridden ? [proposal!.option] : [], context: ctx, about: [s.subject, ...(s.parent ? [s.parent] : [])], evidence: [e],
          rationale: d.reason ? String(d.reason) : null,
          extra: Object.keys(details).length ? { details_json: JSON.stringify(details) } : undefined,
          summary: `${type.replaceAll("_", " ")} about ${x.subject_type} ${x.subject_id}: ${actorDef.kind.toLowerCase().replace("_", " ")} ` +
                   `${stage === "FINAL" ? "chose" : "proposed"} ${option.replaceAll("_", " ")}` + (amount != null ? ` (${amount})` : "") +
                   (overridden ? `, overriding the proposal ${proposal!.option}` : "") + (facts8 ? `. Known then: ${facts8}.` : "."),
        });
        if (proposal) {
          this.rows.preceded_by.push({ from: id, to: proposal.id });
          if (overridden) this.rows.overrides.push({ from: id, to: proposal.id, detected_at: e.occurred_at });
        }
        const dec: Dec = { id, at: e.occurred_at, type, stage, option, subject: s.subject, parent: s.parent, sourceId: e.event_id };
        decisions.push(dec);
        bySource.set(e.event_id, dec);
        continue;
      }

      if (e.event_type === "outcome.observed") {
        const type = snake(String(d.outcome_type ?? ""));
        if (!type) { this.rows.review.push({ event_id: e.event_id, reason: "outcome without a type" }); continue; }
        const pol = snake(String(d.polarity ?? ""));
        const polarity = ["good", "positive", "success"].includes(pol) ? "good" : ["bad", "negative", "failure"].includes(pol) ? "bad" : null;
        if (!polarity) this.notes.unknownPolarity[type] = (this.notes.unknownPolarity[type] ?? 0) + 1;
        const out = this.outcome(e, type, num(d.value), { polarity });
        // An explicit reference first; else FINAL decisions before it within the outcome window, the most specific first:
        // about the same subject, else about its children (an application's outcome, its offers), else about its parent.
        const named = x.follows_id ? bySource.get(x.follows_id) : undefined;
        if (named && ms(named.at) <= ms(e.occurred_at)) { this.ledTo(named.id, out, type, "EXPLICIT_REF", 1.0); continue; }
        const window = (this.reg.windows[type] ?? DEFAULT_WINDOW_DAYS) * DAY_MS;
        const at = ms(e.occurred_at);
        const before = decisions.filter((c) => c.stage === "FINAL" && ms(c.at) <= at && at - ms(c.at) <= window);
        const tiers = [before.filter((c) => c.subject === s.subject), before.filter((c) => c.parent === s.subject),
                       s.parent ? before.filter((c) => c.subject === s.parent) : []];
        const candidates = tiers.find((t) => t.length) ?? [];
        if (!candidates.length) { this.notes.unlinkedOutcomes++; continue; }
        const confidence = candidates.length === 1 ? 1.0 : 0.6;
        for (const c of candidates) this.ledTo(c.id, out, type, "SAME_ENTITY_WINDOW", confidence);
      }
    }
    // A real choice has alternatives taken over time, not two final answers for one subject: flag subjects with FINAL
    // decisions of the same type but different options (e.g. a state every application passes through, then a denial).
    const finals = new Map<string, Set<string>>();
    for (const d of decisions.filter((x) => x.stage === "FINAL")) {
      const k = `${d.type}\u0000${d.subject}`;
      (finals.get(k) ?? finals.set(k, new Set()).get(k)!).add(d.option);
    }
    for (const [k, options] of finals) {
      if (options.size > 1) { const t = k.split("\u0000")[0]; this.notes.conflicting[t] = (this.notes.conflicting[t] ?? 0) + 1; }
    }
    return this.rows;
  }
}

// Every door's events -> rows: Streamly's own types through its detector, generic decision events through the
// generic detector, merged. Streamly-only data produces exactly what the Streamly detector alone did.
export function detectAll(registry: Registry, scenario: string, events: ContractEvent[]): { rows: Rows; notes: GenericNotes | null } {
  const generic = events.filter((e) => isGeneric(e.event_type)), streamly = events.filter((e) => !isGeneric(e.event_type));
  const a = new Detector(registry, scenario).run(streamly);
  if (!generic.length) return { rows: a, notes: null };
  const g = new GenericDetector(registry, scenario);
  const b = g.runGeneric(generic);
  const rows = Object.fromEntries(Object.keys(a).map((k) => {
    const x = a[k as keyof Rows], y = b[k as keyof Rows];
    return [k, x instanceof Map ? new Map([...x, ...(y as Map<string, Row>)]) : [...(x as Row[]), ...(y as Row[])]];
  })) as unknown as Rows;
  return { rows, notes: g.notes };
}
