// The mapping editor's operations (demo spec §23.8, first slice): what a reviewer may set on a record type's fields,
// and the one-click fixes the validator offers. Pure functions over a FileMapping, so the editor and tests share them.
import { DATA_FIELDS, ENTITY_REFS, OPEN_FIELDS, type CanonicalType } from "./contract";
import type { FieldMap, FileMapping, RecordMap } from "./mapping";
import type { CheckFix } from "./validator";

const ACTOR_FIELDS = ["actor.kind", "actor.id", "actor.name", "actor.team", "actor.version"];

// Contract fields a record type of this event type can take (open families as prefixes, e.g. "data.context.").
export function targetsFor(eventType: CanonicalType) {
  const spec = DATA_FIELDS[eventType];
  return {
    fixed: ["event_id", "occurred_at", "received_at", ...ENTITY_REFS.map((r) => `refs.${r}`),
            ...[...spec.required, ...(spec.optional ?? [])].map((d) => `data.${d}`), ...ACTOR_FIELDS],
    open: (OPEN_FIELDS[eventType] ?? []).map((p) => `data.${p}`),
  };
}

// Fields whose value is one of a few words: the editor offers a picker.
export const CHOICES: Record<string, string[]> = {
  "data.polarity": ["good", "bad"],
  "actor.kind": ["HUMAN", "AI_AGENT", "SYSTEM"],
};

// Fields usually set as a fixed value rather than read from a column.
const USUALLY_FIXED = new Set(["refs.subject_type", "refs.parent_type", "refs.subject_system", "refs.parent_system",
                               "data.decision_type", "data.outcome_type", "data.polarity", "actor.kind"]);

export function newField(target: string, columns: string[]): FieldMap {
  const fixed = USUALLY_FIXED.has(target) || !columns.length;
  return { target, column: fixed ? null : columns[0], template: null, value: fixed ? (CHOICES[target]?.[0] ?? "") : null,
           transform: target === "occurred_at" || target === "received_at" ? "timestamp" : "string",
           aliases: [], otherwise: null, reason: "added by the reviewer" };
}

export type SourceMode = "column" | "value" | "template";
export const modeOf = (f: FieldMap): SourceMode => (f.column !== null ? "column" : f.template !== null ? "template" : "value");

// Switch where a field's value comes from, keeping exactly one of column / template / value set.
export function withMode(f: FieldMap, mode: SourceMode, columns: string[]): FieldMap {
  if (mode === modeOf(f)) return f;
  return { ...f, column: mode === "column" ? (columns[0] ?? "") : null, template: mode === "template" ? (f.column ? `{${f.column}}` : "") : null,
           value: mode === "value" ? (f.value ?? CHOICES[f.target]?.[0] ?? "") : null };
}

// The constant a record type gives a field, if it is one.
const constantOf = (rec: RecordMap, target: string) => rec.fields.find((f) => f.target === target && f.column === null && f.template === null)?.value ?? null;
const same = (a: string | null, b: string) => !!a && a.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_") === b.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");

function setConstant(rec: RecordMap, target: string, value: string) {
  const field = rec.fields.find((f) => f.target === target);
  const set: FieldMap = { ...newField(target, []), value, reason: "added from the validator's suggestion" };
  if (field) Object.assign(field, { column: null, template: null, value, aliases: [], otherwise: null, reason: set.reason });
  else rec.fields.push(set);
}

// Apply a validator fix to a copy of the mapping; returns the copy and how many record types changed.
export function applyFix(mapping: FileMapping, fix: CheckFix): { mapping: FileMapping; changed: number } {
  const m = structuredClone(mapping);
  let changed = 0;
  if (fix.kind === "subject_system") {
    for (const rec of m.records) {
      let touched = false;
      if (same(constantOf(rec, "refs.subject_type"), fix.type)) { setConstant(rec, "refs.subject_system", fix.system); touched = true; }
      if (same(constantOf(rec, "refs.parent_type"), fix.type)) { setConstant(rec, "refs.parent_system", fix.system); touched = true; }
      if (touched) changed++;
    }
  }
  return { mapping: m, changed };
}
