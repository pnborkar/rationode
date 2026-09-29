// Uploaded exports -> contract events, driven by a declarative mapping (demo spec §16.2).
// A mapping says, per file: which record types it holds (a row filter), the canonical event type
// each becomes, and for every contract field the source column (or a template or constant), with
// value aliases. Arrays rather than free-form maps, so the mapping agent's output is schema-checked.
import { z } from "zod";
import { CANONICAL_TYPES, type Actor, type ContractEvent } from "./contract";

export const TRANSFORMS = ["string", "number", "boolean", "timestamp", "list", "first"] as const;

export const FieldMapSchema = z.object({
  target: z.string().describe("Contract field: event_id, occurred_at, refs.<ref>, data.<field>, or actor.<kind|id|name|team|version>"),
  column: z.string().nullable().describe("Source column (dotted path for nested JSON, e.g. output.plan); null if template or value is used"),
  template: z.string().nullable().describe("Build the value from columns, e.g. 'zendesk:{Updater ID}'; null if not used"),
  value: z.string().nullable().describe("A constant, e.g. 'HUMAN'; null if not used"),
  transform: z.enum(TRANSFORMS).describe("string | number | boolean (Y/N, yes/no, true/false, 1/0) | timestamp (to ISO UTC) | list (JSON array or ; , | separated) | first (first word)"),
  aliases: z.array(z.object({ from: z.string(), to: z.string() })).describe("Value translations applied to the raw value before the transform, e.g. 'Refund: full' -> 'full_refund'"),
  otherwise: z.string().nullable().describe("Value when aliases are given and none matches (null = keep the value)"),
  reason: z.string().describe("One line: why this column is this field"),
});

export const RecordMapSchema = z.object({
  name: z.string().describe("Short label for this record type, e.g. 'Macro applied rows'"),
  when: z.object({ column: z.string(), equals: z.string() }).nullable()
    .describe("Row filter; null when every row in the file is this record type"),
  event_type: z.enum(CANONICAL_TYPES),
  fields: z.array(FieldMapSchema),
  reason: z.string().describe("One line: why these rows are this event type"),
});

export const FileMappingSchema = z.object({
  file: z.string(),
  source: z.string().describe("Source system, lower-case, e.g. stripe, zendesk, fraudguard, agent_log"),
  records: z.array(RecordMapSchema),
  skipped: z.array(z.object({ when: z.object({ column: z.string(), equals: z.string() }), reason: z.string() }))
    .describe("Row types deliberately not mapped (the detector has no use for them)"),
  reason: z.string().describe("One or two sentences: what this file is"),
});

export type FieldMap = z.infer<typeof FieldMapSchema>;
export type RecordMap = z.infer<typeof RecordMapSchema>;
export type FileMapping = z.infer<typeof FileMappingSchema>;

// ------------------------------------------------------------------ reading files
export type Record_ = Record<string, unknown>;
export type ParsedFile = { name: string; format: "csv" | "jsonl"; columns: string[]; rows: Record_[] };

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

// Nested JSON flattened to dotted paths (arrays kept whole), so columns work the same for CSV and JSONL.
function flatten(obj: Record_, prefix = "", out: Record_ = {}): Record_ {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v as Record_, key, out);
    else out[key] = v;
  }
  return out;
}

export function parseFile(name: string, content: string): ParsedFile {
  const trimmed = content.trimStart();
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson") || trimmed.startsWith("{")) {
    const raw = content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record_);
    const rows = raw.map((r) => flatten(r));
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { name, format: "jsonl", columns, rows };
  }
  const [header, ...body] = parseCsv(content);
  const rows = body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
  return { name, format: "csv", columns: header, rows };
}

// What the mapping agent (and the mapping view) sees of a file: columns, sample rows that cover each
// record type, and the distinct values of low-cardinality columns (record types, codes, labels).
export function profile(f: ParsedFile, samples = 8) {
  const distinct: Record<string, { value: string; count: number }[]> = {};
  for (const col of f.columns) {
    const counts = new Map<string, number>();
    for (const r of f.rows) {
      const v = r[col];
      if (v === undefined || v === null || v === "" || typeof v === "object") continue;
      counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    }
    if (counts.size > 0 && counts.size <= 15 && counts.size < f.rows.length) {
      distinct[col] = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
    }
  }
  // Samples: the first row of each value of the most "type-like" column, then fill from the top.
  const typeCol = Object.entries(distinct).sort((a, b) => a[1].length - b[1].length).find(([, v]) => v.length > 1)?.[0];
  const picked: Record_[] = [];
  if (typeCol) for (const { value } of distinct[typeCol]) {
    const r = f.rows.find((x) => String(x[typeCol]) === value);
    if (r && picked.length < samples) picked.push(r);
  }
  for (const r of f.rows) if (picked.length < samples && !picked.includes(r)) picked.push(r);
  return { file: f.name, format: f.format, rows: f.rows.length, columns: f.columns, distinct, samples: picked };
}

// ------------------------------------------------------------------ the engine
export function toTimestamp(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  let d: Date;
  if (typeof v === "number" || /^\d{9,11}$/.test(String(v))) d = new Date(Number(v) * 1000);
  else {
    let s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00Z";
    else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(" ", "T") + "Z";   // no zone: UTC
    d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class MappingError extends Error {}

function applyTransform(v: unknown, t: FieldMap["transform"]): unknown {
  if (v === null || v === undefined || v === "") return null;
  switch (t) {
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
      if (Number.isNaN(n)) throw new MappingError(`"${v}" is not a number`);
      return n;
    }
    case "boolean": {
      if (typeof v === "boolean") return v;
      const s = String(v).trim().toLowerCase();
      if (["y", "yes", "true", "1", "t"].includes(s)) return true;
      if (["n", "no", "false", "0", "f"].includes(s)) return false;
      throw new MappingError(`"${v}" is not a yes/no value`);
    }
    case "timestamp": {
      const iso = toTimestamp(v);
      if (!iso) throw new MappingError(`"${v}" is not a timestamp`);
      return iso;
    }
    case "list":
      if (Array.isArray(v)) return v.map(String);
      if (String(v).trim().startsWith("[")) return (JSON.parse(String(v)) as unknown[]).map(String);
      return String(v).split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
    case "first":
      return String(v).trim().split(/[\s,;]+/)[0] || null;
    default:
      return typeof v === "string" ? v.trim() : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

export function fieldValue(row: Record_, f: FieldMap): unknown {
  let v: unknown;
  if (f.value !== null && f.value !== undefined) v = f.value;
  else if (f.template) v = f.template.replace(/\{([^}]+)\}/g, (_, c) => String(row[c] ?? ""));
  else if (f.column) v = row[f.column];
  if (f.aliases?.length && v !== null && v !== undefined && v !== "") {
    const hit = f.aliases.find((a) => a.from === String(v).trim());
    if (hit) v = hit.to;
    else if (f.otherwise !== null && f.otherwise !== undefined) v = f.otherwise;
  }
  return applyTransform(v, f.transform);
}

export const matches = (row: Record_, when: RecordMap["when"]) =>
  !when || String(row[when.column] ?? "").trim() === when.equals;

export type MappedEvent = { file: string; row: number; record: string; event: ContractEvent };
export type RowProblem = { file: string; row: number; record: string; target?: string; message: string };

// Map one file's rows to contract events. Rows matching no record type are counted, not guessed.
export function mapFile(f: ParsedFile, m: FileMapping) {
  const events: MappedEvent[] = [], problems: RowProblem[] = [];
  let skipped = 0, unmatched = 0;
  f.rows.forEach((row, i) => {
    const rec = m.records.find((r) => matches(row, r.when));
    if (!rec) {
      if (m.skipped.some((s) => matches(row, s.when))) skipped++;
      else unmatched++;
      return;
    }
    const e: ContractEvent = {
      event_id: "", source: m.source, source_type: rec.when?.equals ?? rec.event_type, event_type: rec.event_type,
      occurred_at: "", received_at: null, entity_refs: {}, actor: null, data: {}, raw: row,
      source_ref: { file: f.name, row: i + 1 },   // data row, counting from 1 after the header
    };
    const actor: Partial<Actor> = {};
    for (const fm of rec.fields) {
      let v: unknown;
      try { v = fieldValue(row, fm); }
      catch (err) { problems.push({ file: f.name, row: i + 1, record: rec.name, target: fm.target, message: (err as Error).message }); continue; }
      const [head, ...rest] = fm.target.split(".");
      const key = rest.join(".");
      if (head === "event_id") e.event_id = v == null ? "" : String(v);
      else if (head === "occurred_at") e.occurred_at = v == null ? "" : String(v);
      else if (head === "received_at") e.received_at = v == null ? null : String(v);
      else if (head === "refs") (e.entity_refs as Record<string, unknown>)[key] = v == null ? null : String(v);
      else if (head === "data") e.data[key] = v;
      else if (head === "actor") (actor as Record<string, unknown>)[key] = v;
    }
    if (actor.id || actor.kind) e.actor = { kind: (actor.kind ?? "HUMAN") as Actor["kind"], id: String(actor.id ?? ""),
                                            name: actor.name ?? null, team: actor.team ?? null, version: actor.version ?? null };
    events.push({ file: f.name, row: i + 1, record: rec.name, event: e });
  });
  return { events, problems, skipped, unmatched };
}
