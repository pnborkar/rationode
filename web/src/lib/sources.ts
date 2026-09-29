// Where a load's rows come from (demo spec §21.2): uploaded files arrive with their contents; Databricks
// tables arrive as references (table + Delta version) and the server reads them itself, so table data
// never passes through the browser (and loads fit serverless request limits). Incremental loads read only
// the rows that changed since the last load (Change Data Feed) and merge them into the rows already stored.
import { readChanges, readTable, tableVersion, type Change } from "./databricks";
import { IS_DEMO, query, SCENARIO } from "./neo4j";
import { mapFile, parseFile, profile, type FileMapping, type ParsedFile, type Record_ } from "./mapping";
import { check, parseAll, run, storedEvents, type TableSource, type UploadedFile } from "./uploads";

export async function readParsed(t: TableSource): Promise<ParsedFile> {
  const r = await readTable(t.table, t.version);
  return parseFile(r.name, r.content);
}

// Uploaded files and table references -> parsed files, in the order given.
export async function resolve(files: UploadedFile[], tables: TableSource[]): Promise<ParsedFile[]> {
  return [...parseAll(files), ...await Promise.all(tables.map(readParsed))];
}

// What the browser gets for a table: its version, row count, and a preview (columns + the example rows
// the mapping agent would see), not its rows.
export async function tablePreview(table: string) {
  const version = await tableVersion(table);
  const f = await readParsed({ table, version });
  return { name: table, version, rows: f.rows.length,
           preview: { name: f.name, format: f.format, columns: f.columns, rows: profile(f).samples } as ParsedFile };
}

// ------------------------------------------------------------------ incremental loads
type Batch = { scenario: string; name: string; sources: TableSource[]; mappings: FileMapping[]; loadedAt: string };

// The latest load from Databricks this app can see (the tenant's history, or the demo's upload batches).
export async function lastDatabricksLoad(): Promise<Batch | null> {
  const [r] = await query<{ scenario: string; name: string; sources: string; mapping: string; at: string }>(
    `MATCH (b:UploadBatch)-[:USED_MAPPING]->(m:Mapping)
     WHERE b.sources_json IS NOT NULL AND (($demo AND b.scenario_id STARTS WITH 'upload:') OR (NOT $demo AND b.scenario_id = $base))
       AND NOT EXISTS { (:UploadBatch)-[:SUPERSEDES]->(b) }
     RETURN b.scenario_id AS scenario, b.name AS name, b.sources_json AS sources, m.mapping_json AS mapping,
            toString(b.loaded_at) AS at ORDER BY b.loaded_at DESC LIMIT 1`, { demo: IS_DEMO, base: SCENARIO });
  return r ? { scenario: r.scenario, name: r.name, sources: JSON.parse(r.sources), mappings: JSON.parse(r.mapping), loadedAt: r.at } : null;
}

export type Range = { table: string; from: number; to: number };

// Which tables moved on since the last load, as version ranges.
export async function pendingRanges(batch: Batch): Promise<Range[]> {
  const now = await Promise.all(batch.sources.map(async (s) => ({ ...s, current: await tableVersion(s.table) })));
  return now.filter((s) => s.current > s.version).map((s) => ({ table: s.table, from: s.version + 1, to: s.current }));
}

// The full current files without re-reading them: the rows already stored (each event keeps its source row)
// with the changes applied, matched by the mapping's event ID. Detection then runs over complete history,
// so decisions that span tables (a ticket, the agent's proposal, the refund) stay whole.
async function merged(batch: Batch, ranges: Range[]) {
  const stored = await storedEvents(batch.scenario);
  const byFile = new Map<string, { id: string; row: number; raw: Record_ }[]>();
  for (const [id, e] of stored) {
    if (!e.file) continue;
    byFile.set(e.file, [...(byFile.get(e.file) ?? []), { id, row: e.row ?? 0, raw: JSON.parse(e.payload) }]);
  }
  const counts: { table: string; from: number; to: number; inserted: number; updated: number; deleted: number }[] = [];
  const files: ParsedFile[] = [];
  for (const s of batch.sources) {
    const mapping = batch.mappings.find((m) => m.file === s.table);
    const rows = new Map((byFile.get(s.table) ?? []).sort((a, b) => a.row - b.row).map((x) => [x.id, x.raw]));
    const range = ranges.find((r) => r.table === s.table);
    if (range && mapping) {
      const changes: Change[] = await readChanges(s.table, range.from, range.to);
      // Flatten the change rows as the table's rows are flattened, then key each by the mapping's event ID.
      const f = parseFile(s.table, changes.map((c) => JSON.stringify(c.row)).join("\n") + "\n");
      const ids = new Map(mapFile(f, mapping).events.map((e) => [e.row - 1, e.event.event_id]));
      const n = { table: s.table, from: range.from, to: range.to, inserted: 0, updated: 0, deleted: 0 };
      changes.forEach((c, i) => {
        const id = ids.get(i) || `unmapped:${range.from}:${i}`;   // rows that map to no event still count as rows
        if (c.type === "delete") { if (rows.delete(id)) n.deleted++; }
        else { if (rows.has(id)) n.updated++; else n.inserted++; rows.set(id, f.rows[i]); }
      });
      counts.push(n);
    }
    const list = [...rows.values()];
    files.push({ name: s.table, format: "jsonl", columns: [...new Set(list.flatMap((r) => Object.keys(r)))], rows: list });
  }
  return { files, counts };
}

// Check (nothing written) or apply the changes since the last load, through the same validator and loader.
export async function incremental(apply: boolean, given?: Range[]) {
  const batch = await lastDatabricksLoad();
  if (!batch) return { error: "No earlier load from Databricks with table versions: load the tables once first." };
  const ranges = given ?? await pendingRanges(batch);
  if (!ranges.length) return { batch: batch.name, scenario: batch.scenario, ranges, changes: [], nothing: true };
  const { files, counts } = await merged(batch, ranges);
  const sources = batch.sources.map((s) => ({ table: s.table, version: ranges.find((r) => r.table === s.table)?.to ?? s.version }));
  if (!apply) return { batch: batch.name, scenario: batch.scenario, ranges, changes: counts, mappings: batch.mappings,
                       report: await check(files, batch.mappings, batch.name) };
  return { batch: batch.name, scenario: batch.scenario, ranges, changes: counts,
           result: await run(files, batch.mappings, batch.name, [], sources) };
}
