// "Connect a source" (demo spec §16.2): uploaded files + an approved mapping -> contract events ->
// the TypeScript detector -> Neo4j under scenario upload:<name>, removable like the Events-tab sets.
import { createHash } from "node:crypto";
import { AGENT_MODEL } from "./agent";
import { Detector, REGISTRY_CYPHER, registryFrom, rowsDict, type Registry } from "./detector";
import { parseFile, type FileMapping, type ParsedFile } from "./mapping";
import { IS_DEMO, query, SCENARIO } from "./neo4j";
import { placeScenario, recomputePoints, touchedPoints } from "./storyTrees";
import { removeScenario, writeRows } from "./storyWriter";
import { validate, type Validation } from "./validator";

export type UploadedFile = { name: string; content: string };

export const MAX_FILE_BYTES = 30_000_000;   // tables from Databricks can be larger than uploads

export async function loadRegistry(): Promise<Registry> {
  return registryFrom(await query(REGISTRY_CYPHER));
}

// In the demo, each load is its own removable batch (upload:<name>). For another tenant (cold start), loads
// are that tenant's own history: they land in its base scenario, and its trees are built from them.
export function scenarioFor(name: string): string {
  if (!IS_DEMO) return SCENARIO;
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
  const scenarios = (await query<{ s: string }>(
    `MATCH (e:Event) WITH DISTINCT e.scenario_id AS s WHERE s <> $scenario AND s <> 'live' AND NOT s ENDS WITH ':live' RETURN s`, { scenario },
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

// What a batch holds now: source ID -> the stored raw row and the load that brought that version.
async function storedEvents(scenario: string) {
  return new Map((await query<{ id: string; payload: string; batch: string | null; file: string | null; row: number | null }>(
    `MATCH (e:Event {scenario_id: $scenario})
     RETURN e.event_id AS id, e.payload_json AS payload, e.batch_id AS batch, e.source_file AS file, e.source_row AS row`,
    { scenario },
  )).map((r) => [r.id.slice(scenario.length + 1), r]));
}

const where = (e: { source_ref?: { file: string; row: number } | null }) =>
  e.source_ref ? `${e.source_ref.file} row ${e.source_ref.row}` : "";

// Compare the files' records with what a batch already holds (same source IDs; same raw row = unchanged).
async function diffAgainst(scenario: string, events: Validation["events"]) {
  const stored = await storedEvents(scenario);
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
  return { scenario, new: fresh, changed, unchanged, removed: gone.length, examples };
}

// Re-uploading is not an error: records already in a batch update that batch (re-detected over the whole
// files, so only what changed changes); identical files load nothing. Records that belong to the history
// or an Events-tab set can't be loaded as an upload.
async function validateAll(files: UploadedFile[], mappings: FileMapping[], name: string, registry: Registry) {
  const parsed = parseAll(files);
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

export async function check(files: UploadedFile[], mappings: FileMapping[], name: string) {
  const report: Partial<Validation> = await validateAll(files, mappings, name, await loadRegistry());
  delete report.events;   // the client gets the report, not every mapped event
  return report;
}

// Provenance for a load (demo spec §17.3): one UploadBatch per load, the approved Mapping it used (by content),
// and on each event its file, data row, and the load that brought this version of the record.
const PROVENANCE = `
  MERGE (m:Mapping {mapping_id: $mappingId})
  ON CREATE SET m.mapping_json = $mappingJson, m.files = $files, m.proposed_by = $proposedBy,
                m.first_approved_at = datetime($loadedAt)
  CREATE (b:UploadBatch {batch_id: $batchId, scenario_id: $scenario, name: $name, loaded_at: datetime($loadedAt),
                         files: $files, records: toInteger($records), new: toInteger($new), changed: toInteger($changed),
                         unchanged: toInteger($unchanged), removed: toInteger($removed), edited_files: $editedFiles})
  MERGE (b)-[:USED_MAPPING]->(m)
  WITH b
  OPTIONAL MATCH (p:UploadBatch {scenario_id: $scenario}) WHERE p <> b AND NOT EXISTS { (:UploadBatch)-[:SUPERSEDES]->(p) }
  FOREACH (x IN CASE WHEN p IS NULL THEN [] ELSE [p] END | MERGE (b)-[:SUPERSEDES]->(x))`;

export async function removeBatches(scenario: string) {
  await query(`MATCH (b:UploadBatch {scenario_id: $scenario}) DETACH DELETE b`, { scenario });
  await query(`MATCH (m:Mapping) WHERE NOT EXISTS { (:UploadBatch)-[:USED_MAPPING]->(m) } DELETE m`);
}

// Validate again server-side (never trust the client's copy), then write and place in the trees.
export async function run(files: UploadedFile[], mappings: FileMapping[], name: string, editedFiles: string[] = []) {
  const registry = await loadRegistry();
  const report = await validateAll(files, mappings, name, registry);
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
  const rows = rowsDict(new Detector(registry, scenario).run(report.events));
  const byId = new Map(report.events.map((e) => [e.event_id, e]));
  rows.events = rows.events.map((r) => {
    const id = String(r.event_id).slice(scenario.length + 1), e = byId.get(id), old = previous.get(id);
    return { ...r, source_file: e?.source_ref?.file ?? null, source_row: e?.source_ref?.row ?? null,
             batch_id: old && old.payload === r.payload_json && old.batch ? old.batch : batchId };   // unchanged keeps its load
  });
  await writeRows(rows);
  const mappingJson = JSON.stringify(mappings);
  await query(PROVENANCE, {
    mappingId: createHash("sha256").update(mappingJson).digest("hex").slice(0, 16), mappingJson,
    files: files.map((f) => f.name), proposedBy: `Claude mapping agent (${AGENT_MODEL}), reviewed and approved in the app`,
    batchId, scenario, name, loadedAt, records: report.events.length,
    new: t ? t.new : report.events.length, changed: t?.changed ?? 0, unchanged: t?.unchanged ?? 0, removed: t?.removed ?? 0,
    editedFiles,
  });
  // A tenant's own history isn't placed into trees: its trees are built from it (pipeline, per tenant).
  const branches = scenario === SCENARIO && !IS_DEMO ? [] : await placeScenario(scenario);
  const customers = rows.entities.filter((e) => e.label === "Customer" && e.source_system === "stripe")
    .map((e) => (e.props as { email: string; name: string | null }))
    .map((p) => ({ email: p.email, name: p.name }));
  return { ok: true as const, scenario, counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])),
           customers, branches };
}

export async function listUploads() {
  return query<{ scenario: string; events: number; decisions: number; customers: number }>(
    `MATCH (e:Event) WHERE ($demo AND e.scenario_id STARTS WITH 'upload:') OR (NOT $demo AND e.scenario_id = $base)
     WITH e.scenario_id AS scenario, count(*) AS events
     OPTIONAL MATCH (d:Decision {scenario_id: scenario})
     WITH scenario, events, count(d) AS decisions
     OPTIONAL MATCH (c:Customer:Entity {scenario_id: scenario, source_system: 'stripe'})
     RETURN scenario, events, decisions, count(c) AS customers ORDER BY scenario`,
    { demo: IS_DEMO, base: SCENARIO },
  );
}

export async function removeUpload(scenario: string) {
  if (!scenario.startsWith("upload:") && (IS_DEMO || scenario !== SCENARIO)) throw new Error("not an upload scenario");
  const touched = await touchedPoints(scenario);
  const removed = await removeScenario(scenario);
  await removeBatches(scenario);
  await recomputePoints(touched);
  return { removed, branchesRestored: touched.length };
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
    { demo: IS_DEMO, base: SCENARIO },
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
