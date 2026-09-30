// "Connect a source" (demo spec §16.2): uploaded files + an approved mapping -> contract events ->
// the TypeScript detector -> Neo4j. In the demo each load is its own scenario (upload:<name>), removable like the
// Events-tab sets. In any other workspace every load is a named *source* inside the workspace scenario (§23.9,
// change 1): its records are compared only with that source's, and decisions are re-detected over all the
// workspace's sources together (one decision can span them), so adding or removing a source never touches another.
import { createHash } from "node:crypto";
import { aiSettings } from "./settings";
import { REGISTRY_CYPHER, registryFrom, rowsDict, type Registry } from "./detector";
import { detectAll, snake } from "./genericDetector";
import { approveIntroduced, deriveAttributes } from "./genericFeatures";
import { isGeneric } from "./contract";
import { mapFile, parseFile, type FileMapping, type ParsedFile, type Record_ } from "./mapping";
import type { ContractEvent } from "./contract";
import type { KnownSubjects } from "./mappingAgent";
import { demoMode, query, baseScenario } from "./neo4j";
import { placeScenario, recomputePoints, touchedPoints } from "./storyTrees";
import { removeScenario, writeRows, type Rows } from "./storyWriter";
import { validate, type Validation } from "./validator";

export type UploadedFile = { name: string; content: string };
export type TableSource = { table: string; version: number };   // a Databricks table at one Delta version

export const MAX_FILE_BYTES = 30_000_000;   // tables from Databricks can be larger than uploads

export async function loadRegistry(): Promise<Registry> {
  return registryFrom(await query(REGISTRY_CYPHER));
}

// In the demo, each load is its own removable batch (upload:<name>). In another workspace, loads are sources of the
// workspace's own history: they land in its base scenario (the load's name is the source), and its trees are built
// from them.
export function scenarioFor(name: string): string {
  if (!demoMode()) return baseScenario();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "batch";
  return `upload:${slug}`;
}

export function parseAll(files: UploadedFile[]): ParsedFile[] {
  return files.map((f) => {
    if (f.content.length > MAX_FILE_BYTES) throw new Error(`${f.name} is larger than 30 MB`);
    return parseFile(f.name, f.content);
  });
}

// Records already in Neo4j under another scenario (another batch, a set, or the history). IDs are
// deterministic per source record, but each scenario prefixes them, so the same files loaded as a
// second batch would duplicate every customer and decision. Same batch name = replace, which is fine.
async function alreadyLoaded(eventIds: string[], scenario: string) {
  // Only the demo's own scenarios: other workspaces are separate, so the same records may be loaded there too.
  const scenarios = (await query<{ s: string }>(
    `MATCH (e:Event) WITH DISTINCT e.scenario_id AS s
     WHERE s <> $scenario AND (s = 'history' OR s STARTS WITH 'story:' OR s STARTS WITH 'upload:') RETURN s`, { scenario },
  )).map((r) => r.s);
  if (!scenarios.length || !eventIds.length) return [];
  return query<{ scenario: string; n: number }>(
    `UNWIND $scenarios AS s
     UNWIND $ids AS id
     MATCH (e:Event {event_id: CASE s WHEN 'history' THEN id ELSE s + '|' + id END})
     RETURN s AS scenario, count(*) AS n ORDER BY n DESC`,
    { scenarios, ids: eventIds },
  );
}

// What a batch (or, in a workspace, one source) holds now: source ID -> the stored raw row and the load that
// brought that version.
export async function storedEvents(scenario: string, source?: string) {
  return new Map((await query<{ id: string; payload: string; batch: string | null; file: string | null; row: number | null;
                                source: string | null }>(
    `MATCH (e:Event {scenario_id: $scenario}) WHERE $source IS NULL OR e.source_name = $source
     RETURN e.event_id AS id, e.payload_json AS payload, e.batch_id AS batch, e.source_file AS file, e.source_row AS row,
            e.source_name AS source`,
    { scenario, source: source ?? null },
  )).map((r) => [r.id.slice(scenario.length + 1), r]));
}

const where = (e: { source_ref?: { file: string; row: number } | null }) =>
  e.source_ref ? `${e.source_ref.file} row ${e.source_ref.row}` : "";

// Compare the files' records with what a batch already holds (same source IDs; same raw row = unchanged).
async function diffAgainst(scenario: string, events: Validation["events"], source?: string) {
  const stored = await storedEvents(scenario, source);
  let fresh = 0, changed = 0, unchanged = 0;
  const examples: string[] = [];
  for (const e of events) {
    const before = stored.get(e.event_id);
    if (before === undefined) { fresh++; if (examples.length < 5) examples.push(`${where(e)} (new)`); }
    else if (before.payload === JSON.stringify(e.raw)) unchanged++;
    else { changed++; if (examples.length < 5) examples.push(`${where(e)} (changed)`); }
  }
  const incoming = new Set(events.map((e) => e.event_id));
  const gone = [...stored.entries()].filter(([id]) => !incoming.has(id));
  for (const [, r] of gone.slice(0, Math.max(0, 5 - examples.length))) {
    examples.push(r.file ? `${r.file} row ${r.row} (removed)` : "a record (removed)");
  }
  return { scenario, source, new: fresh, changed, unchanged, removed: gone.length, examples };
}

// Re-uploading is not an error: records already in a batch update that batch (re-detected over the whole
// files, so only what changed changes); identical files load nothing. Records that belong to the history
// or an Events-tab set can't be loaded as an upload.
async function validateAll(parsed: ParsedFile[], mappings: FileMapping[], name: string, registry: Registry) {
  if (!demoMode()) return validateSource(parsed, mappings, name.trim(), registry);
  let scenario = scenarioFor(name);
  let report = validate(parsed, mappings, registry, scenario);
  const ids = report.events.map((e) => e.event_id).filter(Boolean);
  const overlap = await alreadyLoaded(ids, scenario);
  const batches = overlap.filter((o) => o.scenario.startsWith("upload:"));
  for (const o of overlap.filter((x) => !x.scenario.startsWith("upload:"))) {
    report.checks.unshift({ level: "error", message: `${o.n} of ${report.events.length} records are already in the graph ` +
      `as ${o.scenario}; they can't be loaded again as an upload.` });
    report.ok = false;
  }
  if (batches.length > 1) {
    report.checks.unshift({ level: "error", message: `These records are spread across batches ` +
      `${batches.map((b) => b.scenario).join(" and ")}; remove the ones you don't want first.` });
    report.ok = false;
    return report;
  }
  if (batches.length === 1 && batches[0].scenario !== scenario) {
    scenario = batches[0].scenario;                    // update the batch that holds them
    report = { ...validate(parsed, mappings, registry, scenario), checks: report.checks, ok: report.ok };
  }
  const exists = (await query(`MATCH (e:Event {scenario_id: $scenario}) RETURN e LIMIT 1`, { scenario })).length > 0;
  if (exists) {
    const t = await diffAgainst(scenario, report.events);
    report.target = t;
    const nothing = t.new === 0 && t.changed === 0 && t.removed === 0;
    report.checks.unshift(nothing
      ? { level: "ok", message: `Nothing new: all ${t.unchanged} records are already loaded in ${scenario}.` }
      : { level: "ok", message: `Already loaded as ${scenario}: approving updates it with ${t.new} new and ${t.changed} ` +
          `changed records` + (t.removed ? `; ${t.removed} records not in these files will be removed` : "") + ".",
          examples: t.examples });
  }
  return report;
}

// A workspace load (§23.9): compared with the named source only. Records another source already holds are refused
// (each record has one owner); the rest of the workspace is not part of the comparison.
async function validateSource(parsed: ParsedFile[], mappings: FileMapping[], source: string, registry: Registry) {
  const scenario = baseScenario();
  const report = validate(parsed, mappings, registry, scenario);
  if (!source) {
    report.checks.unshift({ level: "error", message: "Name the source (e.g. \"Loan applications\"): the same name updates it, a new name adds a source." });
    report.ok = false;
    return report;
  }
  await labelSources(scenario);
  const ids = report.events.map((e) => `${scenario}|${e.event_id}`).filter((id) => id.length > scenario.length + 1);
  const owned = await query<{ source: string | null; n: number }>(
    `UNWIND $ids AS id MATCH (e:Event {event_id: id}) WHERE e.scenario_id = $scenario AND coalesce(e.source_name, '') <> $source
     RETURN e.source_name AS source, count(*) AS n ORDER BY n DESC`, { ids, scenario, source });
  for (const o of owned) {
    report.checks.unshift({ level: "error", message: `${o.n} of ${report.events.length} records are already in ` +
      (o.source ? `the source "${o.source}"; load them as "${o.source}" to update it.` : `this workspace from a load with no source name.`) });
    report.ok = false;
  }
  report.checks.unshift(...await subjectJoins(scenario, report.events));
  const others = (await listSources()).filter((x) => x.source !== source);
  const exists = (await query(`MATCH (e:Event {scenario_id: $scenario, source_name: $source}) RETURN e LIMIT 1`, { scenario, source })).length > 0;
  if (exists) {
    const t = await diffAgainst(scenario, report.events, source);
    report.target = t;
    const nothing = t.new === 0 && t.changed === 0 && t.removed === 0;
    // Picking an existing source for different files would replace it: say so loudly and require a confirmation.
    const total = t.unchanged + t.changed + t.removed;
    if (t.removed > 0 && (t.unchanged + t.changed === 0 || t.removed / total >= 0.5)) {
      const files = (await listSources()).find((x) => x.source === source)?.files ?? [];
      report.removal = { source, removed: t.removed, total, files };
      report.checks.unshift({ level: "warn", message: `This would REMOVE ${t.removed.toLocaleString()} of the ${total.toLocaleString()} records ` +
        `in the source "${source}" (${Math.round((t.removed / total) * 100)}%)` +
        (t.unchanged + t.changed === 0 ? `: none of these records are in it, so these files aren't that source's files` : "") +
        (files.length ? ` (its files: ${files.join(", ")})` : "") + `. If this is different data, even data about the same things ` +
        `(e.g. collections on these loans), give it a new source name: it's added beside "${source}", and records that refer to ` +
        `"${source}"'s subjects are linked to them (the join is shown here after validating). To replace the source anyway, approve and confirm.` });
    }
    report.checks.unshift(nothing
      ? { level: "ok", message: `Nothing new: all ${t.unchanged} records are already loaded in the source "${source}".` }
      : { level: "ok", message: `Updates the source "${source}" with ${t.new} new and ${t.changed} changed records` +
          (t.removed ? `; ${t.removed} of its records not in these files will be removed` : "") +
          (others.length ? `. Other sources stay as they are (${others.map((x) => `"${x.source}"`).join(", ")}).` : "."),
          examples: t.examples });
  } else if (report.ok) {
    report.checks.unshift({ level: "ok", message: `A new source "${source}" in ${scenario}` +
      (others.length ? `, alongside ${others.map((x) => `"${x.source}"`).join(", ")} (they stay as they are).` : ".") });
  }
  return report;
}

export async function check(parsed: ParsedFile[], mappings: FileMapping[], name: string) {
  const report: Partial<Validation> = await validateAll(parsed, mappings, name, await loadRegistry());
  delete report.events;   // the client gets the report, not every mapped event
  return report;
}

// Provenance for a load (demo spec §17.3): one UploadBatch per load, the approved Mapping it used (by content),
// and on each event its file, data row, and the load that brought this version of the record.
const PROVENANCE = `
  MERGE (m:Mapping {mapping_id: $mappingId})
  ON CREATE SET m.mapping_json = $mappingJson, m.files = $files, m.proposed_by = $proposedBy,
                m.first_approved_at = datetime($loadedAt)
  CREATE (b:UploadBatch {batch_id: $batchId, scenario_id: $scenario, name: $name, source_name: $name, loaded_at: datetime($loadedAt),
                         files: $files, records: toInteger($records), new: toInteger($new), changed: toInteger($changed),
                         unchanged: toInteger($unchanged), removed: toInteger($removed), edited_files: $editedFiles,
                         sources_json: $sourcesJson})
  MERGE (b)-[:USED_MAPPING]->(m)
  WITH b
  OPTIONAL MATCH (p:UploadBatch {scenario_id: $scenario}) WHERE p <> b AND NOT EXISTS { (:UploadBatch)-[:SUPERSEDES]->(p) }
    AND (NOT $perSource OR p.source_name = $name)   // a workspace: each source has its own chain of loads
  FOREACH (x IN CASE WHEN p IS NULL THEN [] ELSE [p] END | MERGE (b)-[:SUPERSEDES]->(x))`;

export async function removeBatches(scenario: string) {
  await query(`MATCH (b:UploadBatch {scenario_id: $scenario}) DETACH DELETE b`, { scenario });
  await query(`MATCH (m:Mapping) WHERE NOT EXISTS { (:UploadBatch)-[:USED_MAPPING]->(m) } DELETE m`);
}

// Validate again server-side (never trust the client's copy), then write and place in the trees. `sources`:
// the Databricks tables and versions read, kept on the batch so the next load reads only what changed.
export async function run(parsed: ParsedFile[], mappings: FileMapping[], name: string, editedFiles: string[] = [],
                          sources: TableSource[] = [], confirmRemoval = false) {
  if (!demoMode()) return runSource(parsed, mappings, name.trim(), editedFiles, sources, confirmRemoval);
  const registry = await loadRegistry();
  const report = await validateAll(parsed, mappings, name, registry);
  if (!report.ok) return { ok: false as const, error: "The mapping has validation errors", report: { ...report, events: undefined } };
  const t = report.target;
  if (t && t.new === 0 && t.changed === 0 && t.removed === 0) {
    return { ok: false as const, error: `Nothing new: all records are already loaded in ${t.scenario}.` };
  }
  const scenario = t?.scenario ?? scenarioFor(name);
  const loadedAt = new Date().toISOString(), batchId = `${scenario}@${loadedAt}`;
  const previous = await storedEvents(scenario);
  const touched = await touchedPoints(scenario);
  if (touched.length || (await query(`MATCH (e:Event {scenario_id: $scenario}) RETURN e LIMIT 1`, { scenario })).length) {
    await removeScenario(scenario);        // re-running a batch replaces it
    await recomputePoints(touched);
  }
  const rows = rowsDict(detectAll(registry, scenario, report.events).rows);   // Streamly and generic events (§23.8)
  const byId = new Map(report.events.map((e) => [e.event_id, e]));
  rows.events = rows.events.map((r) => {
    const id = String(r.event_id).slice(scenario.length + 1), e = byId.get(id), old = previous.get(id);
    return { ...r, source_file: e?.source_ref?.file ?? null, source_row: e?.source_ref?.row ?? null, source_name: name,
             batch_id: old && old.payload === r.payload_json && old.batch ? old.batch : batchId };   // unchanged keeps its load
  });
  await writeRows(rows);
  const mappingJson = JSON.stringify(mappings);
  await query(PROVENANCE, {
    mappingId: createHash("sha256").update(mappingJson).digest("hex").slice(0, 16), mappingJson,
    files: parsed.map((f) => f.name), proposedBy: `Claude mapping agent (${(await aiSettings()).mappingModel}), reviewed and approved in the app`,
    batchId, scenario, name, loadedAt, records: report.events.length,
    new: t ? t.new : report.events.length, changed: t?.changed ?? 0, unchanged: t?.unchanged ?? 0, removed: t?.removed ?? 0,
    editedFiles, sourcesJson: sources.length ? JSON.stringify(sources) : null, perSource: false,
  });
  // Generic decision types (§23.8): derive their attributes from the data and encode their contexts, so they can be
  // precedent; and list the loaded subjects (there are no Stripe customers in another domain).
  const genericTypes = [...new Set(report.events.filter((e) => isGeneric(e.event_type) && e.data.decision_type)
    .map((e) => rows.decisions.find((d) => d.decision_id === `${scenario === "history" ? "" : `${scenario}|`}dec:${e.event_id}`)?.decision_type as string)
    .filter(Boolean))];
  const features = genericTypes.length ? await deriveAttributes(scenario, genericTypes) : null;
  if (genericTypes.length) await approveIntroduced(scenario, genericTypes);   // what the approved mapping introduced
  const subjects = rows.entities.filter((e) => (e.props as { subject_type?: string })?.subject_type
      && !(rows.links ?? []).some((l) => l.type === "PART_OF" && l.from === e.entity_id))
    .slice(0, 30).map((e) => ({ id: e.entity_id as string, label: e.label as string, key: String(e.source_key).split(":").slice(1).join(":") }));
  // A tenant's own history isn't placed into trees: its trees are built from it (pipeline, per tenant).
  const branches = scenario === baseScenario() && !demoMode() ? [] : await placeScenario(scenario);
  const customers = rows.entities.filter((e) => e.label === "Customer" && e.source_system === "stripe")
    .map((e) => (e.props as { email: string; name: string | null }))
    .map((p) => ({ email: p.email, name: p.name }));
  return { ok: true as const, scenario, counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])),
           customers, branches, subjects, features };
}

// ------------------------------------------------------------------ sources within a workspace (§23.9, change 1)

// One-time labelling: loads made before sources existed become sources named after their load (batch) name.
async function labelSources(scenario: string) {
  await query(`MATCH (b:UploadBatch {scenario_id: $scenario}) WHERE b.source_name IS NULL SET b.source_name = b.name`, { scenario });
  await query(
    `MATCH (e:Event {scenario_id: $scenario}) WHERE e.source_name IS NULL AND e.batch_id IS NOT NULL
     MATCH (b:UploadBatch {batch_id: e.batch_id}) SET e.source_name = b.source_name`, { scenario });
}

// Subjects the workspace already holds (for the mapping agent: a new file may name the same ones, §23.9).
export async function knownSubjects(): Promise<KnownSubjects> {
  if (demoMode()) return [];
  const rows = await query<{ type: string; system: string; count: number; keys: string[] }>(
    `MATCH (e:Entity {scenario_id: $scenario}) WHERE e.subject_type IS NOT NULL
     WITH e.subject_type AS type, e.source_system AS system, count(*) AS count, collect(e.source_key)[..3] AS keys
     RETURN type, system, count, keys ORDER BY count DESC LIMIT 20`, { scenario: baseScenario() });
  return rows.map((r) => ({ type: r.type, system: r.system, count: r.count, examples: r.keys.map((k) => k.split(":").slice(1).join(":")) }));
}

// How a load's subjects meet the workspace's: joined to existing subjects of another system (refs.subject_system), or
// sharing type and ID with another system's subjects while mapped as separate ones (probably the same things: say so).
async function subjectJoins(scenario: string, events: ContractEvent[]) {
  const keys = new Map<string, { type: string; key: string; system: string; own: string }>();
  for (const e of events) {
    const x = e.entity_refs, own = e.source;
    const add = (type?: string | null, id?: string | null, named?: string | null) => {
      if (!type || !id) return;
      const system = named?.trim().toLowerCase() || own, key = `${snake(type)}:${id}`;
      keys.set(`${system}|${key}`, { type, key, system, own });
    };
    add(x.subject_type, x.subject_id, x.subject_system);
    add(x.parent_type, x.parent_id, x.parent_system ?? x.subject_system);
  }
  if (!keys.size) return [];
  // One pass over the workspace's subjects with these keys, then matched here.
  const existing = await query<{ key: string; system: string }>(
    `MATCH (e:Entity {scenario_id: $scenario}) WHERE e.subject_type IS NOT NULL AND e.source_key IN $keys
     RETURN e.source_key AS key, e.source_system AS system`, { scenario, keys: [...new Set([...keys.values()].map((k) => k.key))] });
  const systemsOf = new Map<string, string[]>();
  for (const x of existing) systemsOf.set(x.key, [...(systemsOf.get(x.key) ?? []), x.system]);
  const counts = new Map<string, { type: string; mapped: string; existing: string; n: number }>();
  for (const k of keys.values()) {
    for (const sys of systemsOf.get(k.key) ?? []) {
      if (sys === k.own) continue;   // this source's own subjects (an update)
      const id = `${k.type}|${k.system}|${sys}`;
      const c = counts.get(id) ?? counts.set(id, { type: k.type, mapped: k.system, existing: sys, n: 0 }).get(id)!;
      c.n++;
    }
  }
  return [...counts.values()].map((f) => f.mapped === f.existing
    ? { level: "ok" as const, message: `${f.n} ${f.type} subject(s) in these files are existing ones from "${f.existing}": they join that source's ${f.type}s.` }
    : { level: "warn" as const, message: `${f.n} ${f.type} ID(s) in these files match ${f.type}s already in the workspace from "${f.existing}", ` +
        `but are mapped as "${f.mapped}" ${f.type}s, so they'll be separate. If they're the same ${f.type}s, set refs.subject_system ` +
        `(or refs.parent_system for the parent) to "${f.existing}".` });
}

export type SourceInfo = { source: string; events: number; decisions: number; files: string[]; loaded_at: string | null };

// The workspace's sources, with what each holds (decisions are counted by the source of the event they came from).
export async function listSources(): Promise<SourceInfo[]> {
  if (demoMode()) return [];
  const scenario = baseScenario();
  await labelSources(scenario);
  return query<SourceInfo>(
    `MATCH (e:Event {scenario_id: $scenario}) WHERE e.source_name IS NOT NULL
     WITH e.source_name AS source, count(e) AS events
     OPTIONAL MATCH (d:Decision {scenario_id: $scenario})-[:EVIDENCED_BY]->(:Event {scenario_id: $scenario, source_name: source})
     WITH source, events, count(DISTINCT d) AS decisions
     OPTIONAL MATCH (b:UploadBatch {scenario_id: $scenario, source_name: source}) WHERE NOT EXISTS { (:UploadBatch)-[:SUPERSEDES]->(b) }
     RETURN source, events, decisions, coalesce(b.files, []) AS files, toString(b.loaded_at) AS loaded_at ORDER BY source`,
    { scenario });
}

// The contract events of every source except one, rebuilt from what the graph keeps: each event's raw row (with its
// file and row) and the mapping its source's latest load approved. Mapping is deterministic, so this reproduces the
// events that source loaded, without its files.
async function otherSourceEvents(scenario: string, except: string | null) {
  const stored = await query<{ id: string; source: string | null; file: string | null; row: number | null; payload: string;
                               batch: string | null }>(
    `MATCH (e:Event {scenario_id: $scenario}) WHERE $except IS NULL OR coalesce(e.source_name, '') <> $except
     RETURN e.event_id AS id, e.source_name AS source, e.source_file AS file, e.source_row AS row, e.payload_json AS payload,
            e.batch_id AS batch`, { scenario, except });
  const unowned = stored.filter((e) => !e.source || !e.file);
  if (unowned.length) {
    return { error: `${unowned.length} records in ${scenario} were loaded outside Connect a source (no source or file), ` +
                    `so they can't be kept beside another source. Remove the workspace's data and load it here first.` };
  }
  const mappings = new Map((await query<{ source: string; mapping: string }>(
    `MATCH (b:UploadBatch {scenario_id: $scenario})-[:USED_MAPPING]->(m:Mapping)
     WHERE b.source_name IS NOT NULL AND NOT EXISTS { (:UploadBatch)-[:SUPERSEDES]->(b) }
     RETURN b.source_name AS source, m.mapping_json AS mapping`, { scenario })).map((r) => [r.source, JSON.parse(r.mapping) as FileMapping[]]));
  const info = new Map(stored.map((e) => [e.id.slice(scenario.length + 1), e]));
  const events: ContractEvent[] = [];
  for (const source of new Set(stored.map((e) => e.source!))) {
    const maps = mappings.get(source);
    if (!maps) return { error: `The source "${source}" has no approved mapping in the graph, so it can't be rebuilt.` };
    const byFile = new Map<string, Map<number, Record_>>();
    for (const e of stored.filter((x) => x.source === source)) {
      const rows = byFile.get(e.file!) ?? byFile.set(e.file!, new Map()).get(e.file!)!;
      rows.set(e.row ?? 0, JSON.parse(e.payload));
    }
    for (const [file, rows] of byFile) {
      const mapping = maps.find((m) => m.file === file);
      if (!mapping) return { error: `The source "${source}" has no mapping for ${file}.` };
      const list = [...rows].sort((a, b) => a[0] - b[0]).map(([, raw]) => raw);
      const f: ParsedFile = { name: file, format: "jsonl", columns: [...new Set(list.flatMap((r) => Object.keys(r)))], rows: list };
      for (const m of mapFile(f, mapping).events) {
        const kept = info.get(m.event.event_id);
        if (!kept) continue;   // a row can map to more than one record type; only what was loaded is kept
        events.push({ ...m.event, source_ref: { file, row: kept.row ?? 0 } });
      }
    }
  }
  const missing = stored.length - events.length;
  if (missing > 0) return { error: `${missing} stored records no longer come out of their source's mapping, so the workspace can't be rebuilt safely.` };
  return { events, info };
}

// Rewrite the workspace from all its events: nodes no longer produced are removed (with the tree leaves they sat in
// recomputed), the detector's relationships are rewritten, and everything else is kept: analysis made from the data
// (similar-case links, tree placements, embeddings) stays on the decisions that remain.
const DETECTOR_RELS = {
  Decision: "CONSIDERED|MADE_BY|ABOUT|PRECEDED_BY|OVERRIDES|UNDER_POLICY|EVIDENCED_BY|LED_TO|HAD_CONTEXT|INSTANCE_OF",
  Outcome: "EVIDENCED_BY",
  Entity: "PART_OF|PAID_WITH|FROM_DEVICE|USED|SAME_AS",
};
const NODE_IDS: [string, string, string][] = [   // label, id property, rows table
  ["Event", "event_id", "events"], ["Decision", "decision_id", "decisions"], ["Context", "context_id", "contexts"],
  ["Entity", "entity_id", "entities"], ["Outcome", "outcome_id", "outcomes"], ["Actor", "actor_id", "actors"],
];

async function rewriteWorkspace(scenario: string, rows: Rows) {
  const keep = (table: string, prop: string) => (rows[table] ?? []).map((r) => r[prop] as string);
  const touched = (await query<{ id: string }>(
    `MATCH (d:Decision {scenario_id: $scenario})-[:AT_POINT]->(p:DecisionPoint) WHERE NOT d.decision_id IN $ids
     RETURN DISTINCT p.point_id AS id`, { scenario, ids: keep("decisions", "decision_id") })).map((r) => r.id);
  let removed = 0;
  for (const [label, prop, table] of NODE_IDS) {
    for (let n = -1; n !== 0;) {
      const [r] = await query<{ n: number }>(
        `MATCH (x:${label} {scenario_id: $scenario}) WHERE NOT x.${prop} IN $ids
         WITH x LIMIT 10000 DETACH DELETE x RETURN count(*) AS n`, { scenario, ids: keep(table, prop) });
      n = r?.n ?? 0;
      removed += n;
    }
  }
  for (const [label, types] of Object.entries(DETECTOR_RELS)) {
    for (let n = -1; n !== 0;) {
      const [r] = await query<{ n: number }>(
        `MATCH (:${label} {scenario_id: $scenario})-[x:${types}]->() WITH x LIMIT 20000 DELETE x RETURN count(*) AS n`, { scenario });
      n = r?.n ?? 0;
    }
  }
  await writeRows(rows);
  if (touched.length) await recomputePoints(touched);
  return removed;
}

// Detect over the given events plus every other source's, write, and refresh what depends on the decisions.
async function rebuild(scenario: string, except: string | null, events: ContractEvent[], annotate: (id: string) => Record<string, unknown>) {
  const registry = await loadRegistry();
  const others = await otherSourceEvents(scenario, except);
  if ("error" in others) return { error: others.error! };
  const all = [...others.events, ...events];
  const rows = rowsDict(detectAll(registry, scenario, all).rows);
  rows.events = rows.events.map((r) => {
    const id = String(r.event_id).slice(scenario.length + 1), kept = others.info.get(id);
    return { ...r, ...(kept ? { source_file: kept.file, source_row: kept.row, batch_id: kept.batch, source_name: kept.source } : annotate(id)) };
  });
  const removed = await rewriteWorkspace(scenario, rows);
  // Decision types that came from generic decision events (§23.8): their attributes are derived from the data.
  const genericEvents = new Set(all.filter((e) => isGeneric(e.event_type)).map((e) => `${scenario}|${e.event_id}`));
  const genericDecisions = new Set((rows.evidenced_by ?? []).filter((e) => e.kind === "Decision" && genericEvents.has(e.event_id as string))
    .map((e) => e.node_id as string));
  const genericTypes = [...new Set(rows.decisions.filter((d) => genericDecisions.has(d.decision_id as string)).map((d) => d.decision_type as string))];
  const features = genericTypes.length ? await deriveAttributes(scenario, genericTypes) : null;
  await markDataChanged(scenario);
  return { rows, removed, features, genericTypes };
}

async function runSource(parsed: ParsedFile[], mappings: FileMapping[], source: string, editedFiles: string[], sources: TableSource[],
                         confirmRemoval: boolean) {
  const registry = await loadRegistry();
  const report = await validateSource(parsed, mappings, source, registry);
  if (!report.ok) return { ok: false as const, error: "The mapping has validation errors", report: { ...report, events: undefined } };
  if (report.removal && !confirmRemoval) {
    return { ok: false as const, error: `Not loaded: this would remove ${report.removal.removed} of the ${report.removal.total} records in the ` +
      `source "${source}". Use a new source name for different data, or confirm the replacement.` };
  }
  const t = report.target;
  if (t && t.new === 0 && t.changed === 0 && t.removed === 0) {
    return { ok: false as const, error: `Nothing new: all records are already loaded in the source "${source}".` };
  }
  const scenario = baseScenario();
  const loadedAt = new Date().toISOString(), batchId = `${scenario}@${loadedAt}`;
  const previous = await storedEvents(scenario, source);
  const byId = new Map(report.events.map((e) => [e.event_id, e]));
  const r = await rebuild(scenario, source, report.events, (id) => {
    const e = byId.get(id), old = previous.get(id);
    return { source_file: e?.source_ref?.file ?? null, source_row: e?.source_ref?.row ?? null, source_name: source,
             batch_id: old && old.payload === JSON.stringify(e?.raw) && old.batch ? old.batch : batchId };   // unchanged keeps its load
  });
  if ("error" in r) return { ok: false as const, error: r.error };
  const mappingJson = JSON.stringify(mappings);
  await query(PROVENANCE, {
    mappingId: createHash("sha256").update(mappingJson).digest("hex").slice(0, 16), mappingJson,
    files: parsed.map((f) => f.name), proposedBy: `Claude mapping agent (${(await aiSettings()).mappingModel}), reviewed and approved in the app`,
    batchId, scenario, name: source, loadedAt, records: report.events.length,
    new: t ? t.new : report.events.length, changed: t?.changed ?? 0, unchanged: t?.unchanged ?? 0, removed: t?.removed ?? 0,
    editedFiles, sourcesJson: sources.length ? JSON.stringify(sources) : null, perSource: true,
  });
  // What this load's mapping introduced is approved with it (§23.8).
  const introduced = [...new Set(report.events.filter((e) => isGeneric(e.event_type) && e.data.decision_type)
    .map((e) => r.rows.decisions.find((d) => d.decision_id === `${scenario}|dec:${e.event_id}`)?.decision_type as string).filter(Boolean))];
  if (introduced.length) await approveIntroduced(scenario, introduced);
  // What this source brought: its systems' subjects and customers (the rest of the workspace is unchanged).
  const systems = new Set(mappings.map((m) => m.source));
  const mine = r.rows.entities.filter((e) => systems.has(e.source_system as string));
  const subjects = mine.filter((e) => (e.props as { subject_type?: string })?.subject_type
      && !(r.rows.links ?? []).some((l) => l.type === "PART_OF" && l.from === e.entity_id))
    .slice(0, 30).map((e) => ({ id: e.entity_id as string, label: e.label as string, key: String(e.source_key).split(":").slice(1).join(":") }));
  const customers = mine.filter((e) => e.label === "Customer" && e.source_system === "stripe")
    .map((e) => (e.props as { email: string; name: string | null })).map((p) => ({ email: p.email, name: p.name }));
  return { ok: true as const, scenario, source, counts: Object.fromEntries(Object.entries(r.rows).map(([k, v]) => [k, v.length])),
           customers, branches: [], subjects, features: r.features, analysis: await analysisStatus() };
}

// Remove one source: its events go and the workspace is re-detected from the others (a decision whose outcome came
// from this source loses that outcome). Removing the last source removes the workspace's data.
export async function removeSource(source: string) {
  if (demoMode()) throw new Error("the demo has no sources; delete its upload batch");
  const scenario = baseScenario();
  const all = await listSources();
  if (!all.some((x) => x.source === source)) throw new Error(`no source "${source}" in ${scenario}`);
  if (all.length === 1) return { source, last: true, ...(await removeTenantData()) };
  const r = await rebuild(scenario, source, [], () => ({}));
  if ("error" in r) throw new Error(r.error);
  await query(`MATCH (b:UploadBatch {scenario_id: $scenario, source_name: $source}) DETACH DELETE b`, { scenario, source });
  await query(`MATCH (m:Mapping) WHERE NOT EXISTS { (:UploadBatch)-[:USED_MAPPING]->(m) } DELETE m`);
  return { source, removed: r.removed, analysis: await analysisStatus() };
}

// Trees and similar-case links are built by the pipeline from the workspace's data; after a source changes they
// describe the data as it was until they're rebuilt.
async function markDataChanged(scenario: string) {
  await query(`MERGE (t:TenantConfig {tenant: $scenario, kind: 'data'}) SET t.changed_at = datetime()`, { scenario });
}

export async function analysisStatus() {
  if (demoMode()) return null;
  const [r] = await query<{ changed: string | null; built: string | null; trees: number; decisions: number }>(
    `OPTIONAL MATCH (c:TenantConfig {tenant: $scenario, kind: 'data'})
     OPTIONAL MATCH (t:DecisionTree {scenario_id: $scenario})
     WITH c, max(t.built_at) AS built, count(t) AS trees
     CALL (c) { MATCH (d:Decision {scenario_id: $scenario}) RETURN count(d) AS decisions }
     RETURN toString(c.changed_at) AS changed, toString(built) AS built, trees, decisions`, { scenario: baseScenario() });
  const stale = !!r && r.trees > 0 && !!r.changed && !!r.built && r.changed > r.built;
  return { stale, noTrees: !!r && r.trees === 0 && r.decisions > 0, changed_at: r?.changed ?? null, built_at: r?.built ?? null };
}

export async function listUploads() {
  return query<{ scenario: string; events: number; decisions: number; customers: number }>(
    `MATCH (e:Event) WHERE ($demo AND e.scenario_id STARTS WITH 'upload:') OR (NOT $demo AND e.scenario_id = $base)
     WITH e.scenario_id AS scenario, count(*) AS events
     OPTIONAL MATCH (d:Decision {scenario_id: scenario})
     WITH scenario, events, count(d) AS decisions
     OPTIONAL MATCH (c:Customer:Entity {scenario_id: scenario, source_system: 'stripe'})
     RETURN scenario, events, decisions, count(c) AS customers ORDER BY scenario`,
    { demo: demoMode(), base: baseScenario() },
  );
}

export async function removeUpload(scenario: string, source?: string) {
  // The demo removes its upload batches; a workspace one of its sources (never another app's data).
  if (demoMode() ? !scenario.startsWith("upload:") : scenario !== baseScenario()) throw new Error("not an upload scenario of this app");
  if (!demoMode()) {
    if (!source) throw new Error("name the source to remove");
    return removeSource(source);
  }
  const touched = await touchedPoints(scenario);
  const removed = await removeScenario(scenario);
  await removeBatches(scenario);
  await recomputePoints(touched);
  return { removed, branchesRestored: touched.length };
}

// Settings → "Remove all of this tenant's data" (demo spec §22): its history, trees and points, analytics
// links, load batches and live data, as the pipeline's remove-tenant does, but its saved settings (connections,
// AI) stay so it can be loaded again. Never the demo.
const TENANT_LABELS = ["DecisionPoint", "DecisionTree", "Event", "Decision", "Context", "Entity", "Outcome", "Actor", "UploadBatch"];

export async function removeTenantData() {
  if (demoMode()) throw new Error("refusing: this is the demo, not a tenant");
  const removed: Record<string, number> = {};
  for (const scenario of [baseScenario(), `${baseScenario()}:live`]) {
    for (const label of TENANT_LABELS) {
      for (let n = -1; n !== 0;) {   // in chunks until none are left
        const [r] = await query<{ n: number }>(
          `MATCH (x:${label} {scenario_id: $scenario}) WITH x LIMIT 10000 DETACH DELETE x RETURN count(*) AS n`, { scenario });
        n = r?.n ?? 0;
        if (n) removed[label] = (removed[label] ?? 0) + n;
      }
    }
  }
  await query(`MATCH (m:Mapping) WHERE NOT EXISTS { (:UploadBatch)-[:USED_MAPPING]->(m) } DELETE m`);
  return { tenant: baseScenario(), removed };
}

// Uploaded customers with a case (a support ticket or a card dispute), for the live tab's dropdown.
// Their message: the ticket's subject from the export, or, for customers who went straight to their
// bank, a line in their words from the dispute category (as the Events-tab sets do).
const BANK_MESSAGE: Record<string, (usd: string) => string> = {
  subscription_canceled: (usd) => `I thought I canceled. Why was I charged ${usd} again?`,
  not_recognized: (usd) => `I don't recognise a ${usd} charge from Streamly on my card.`,
  unauthorized: (usd) => `I never signed up for Streamly. Why was I charged ${usd}?`,
  duplicate_charge: (usd) => `I was charged ${usd} twice by Streamly.`,
};

export async function uploadedCases() {
  const rows = await query<{ scenario: string; email: string; name: string; subject: string | null;
                             dispute: string | null; amount: number | null }>(
    `MATCH (c:Customer:Entity {source_system: 'stripe'})
     WHERE ($demo AND c.scenario_id STARTS WITH 'upload:') OR (NOT $demo AND c.scenario_id = $base)
     OPTIONAL MATCH (c)<-[:ABOUT]-(:Decision)-[:ABOUT]->(t:Ticket)
     OPTIONAL MATCH (c)<-[:ABOUT]-(:Decision)-[:ABOUT]->(dp:Dispute)
     OPTIONAL MATCH (c)<-[:ABOUT]-(:Decision)-[:ABOUT]->(ch:Charge)
     WITH c, head(collect(DISTINCT t.subject)) AS subject, head(collect(DISTINCT dp.category)) AS dispute,
          max(ch.amount_usd) AS amount
     WHERE subject IS NOT NULL OR dispute IS NOT NULL
     RETURN c.scenario_id AS scenario, c.email AS email, c.name AS name, subject, dispute, amount
     ORDER BY scenario, email`,
    { demo: demoMode(), base: baseScenario() },
  );
  // Ordered by email, so each customer's position (their live ticket number) is stable.
  return rows.map((r) => {
    const usd = r.amount != null ? `$${Math.round(r.amount)}` : "this";
    const viaBank = !r.subject;
    return {
      scenario: r.scenario, email: r.email, name: r.name,
      message: r.subject ?? (BANK_MESSAGE[r.dispute ?? ""] ?? BANK_MESSAGE.not_recognized)(usd),
      via_bank: viaBank,
      case_in_files: viaBank ? `card dispute (${r.dispute?.replaceAll("_", " ")})` : `support ticket: "${r.subject}"`,
    };
  });
}
