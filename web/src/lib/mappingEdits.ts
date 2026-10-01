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

// ------------------------------------------------------------------ reusing an approved mapping (§23.8 Gap 1)

// The columns a file mapping reads: field columns, columns named in templates, and the row-type filters.
export function columnsUsed(m: FileMapping): string[] {
  const cols = new Set<string>();
  for (const r of m.records) {
    if (r.when) cols.add(r.when.column);
    for (const f of r.fields) {
      if (f.column) cols.add(f.column);
      for (const [, c] of (f.template ?? "").matchAll(/\{([^}]+)\}/g)) cols.add(c);
    }
  }
  for (const s of m.skipped) cols.add(s.when.column);
  return [...cols];
}

// The approved mapping for a file: the one made for a file of the same name, else one whose columns are all in this
// file (next month's export under a new name); null when none fits. The mapping is re-pointed at this file's name.
export function matchMapping(file: { name: string; columns: string[] }, approved: FileMapping[]):
    { mapping: FileMapping; how: "same file name" | "same columns"; was: string } | null {
  const exact = approved.find((m) => m.file === file.name);
  if (exact && columnsUsed(exact).every((c) => file.columns.includes(c))) return { mapping: exact, how: "same file name", was: exact.file };
  const fits = approved.filter((m) => columnsUsed(m).every((c) => file.columns.includes(c)))
    .sort((a, b) => columnsUsed(b).length - columnsUsed(a).length);
  return fits[0] ? { mapping: { ...structuredClone(fits[0]), file: file.name }, how: "same columns", was: fits[0].file } : null;
}

// A mapping's content without what doesn't change its output (reasons, the file's name), to tell whether a mapping
// differs from the approved one.
export function mappingFingerprint(mappings: FileMapping[]): string {
  const strip = (m: FileMapping) => ({ source: m.source, skipped: m.skipped.map((x) => x.when),
    records: m.records.map((r) => ({ when: r.when, event_type: r.event_type,
      fields: r.fields.map((f) => ({ target: f.target, column: f.column, template: f.template, value: f.value, transform: f.transform,
                                     aliases: f.aliases, otherwise: f.otherwise })) })) });
  return JSON.stringify(mappings.map(strip).map((x) => JSON.stringify(x)).sort());
}

// ------------------------------------------------------------------ mapping files (§23.8 Gap 2: export / import)

export type MappingFile = { rationode_mapping: 1; contract_version: string; workspace: string; source: string | null;
                            approved_at: string | null; files: string[]; mappings: FileMapping[] };

export function mappingFile(mappings: FileMapping[], meta: { workspace: string; source: string | null; approvedAt: string | null }, contractVersion: string): MappingFile {
  return { rationode_mapping: 1, contract_version: contractVersion, workspace: meta.workspace, source: meta.source,
           approved_at: meta.approvedAt, files: mappings.map((m) => m.file), mappings };
}

// Read an uploaded mapping file (an exported one, or a bare list of file mappings); each mapping is schema-checked.
export function readMappingFile(text: string, schema: { safeParse: (x: unknown) => { success: boolean; data?: unknown; error?: { message: string } } }):
    { mappings: FileMapping[]; meta: Partial<MappingFile> } | { error: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { error: "not a JSON file" }; }
  const list = Array.isArray(raw) ? raw : (raw as { mappings?: unknown })?.mappings;
  if (!Array.isArray(list) || !list.length) return { error: "no mappings in this file" };
  const mappings: FileMapping[] = [];
  for (const [i, m] of list.entries()) {
    const r = schema.safeParse(m);
    if (!r.success) return { error: `mapping ${i + 1} isn't a valid mapping: ${r.error?.message.slice(0, 200)}` };
    mappings.push(r.data as FileMapping);
  }
  return { mappings, meta: Array.isArray(raw) ? {} : (raw as Partial<MappingFile>) };
}

// Save JSON as a file in the browser.
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const mappingFileName = (workspace: string, source: string | null, date = new Date().toISOString().slice(0, 10)) =>
  `${[workspace, source ?? "mapping"].map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).join("-")}-mapping-${date}.json`;
