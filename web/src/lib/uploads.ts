// "Connect a source" (demo spec §16.2): uploaded files + an approved mapping -> contract events ->
// the TypeScript detector -> Neo4j under scenario upload:<name>, removable like the Events-tab sets.
import { Detector, REGISTRY_CYPHER, registryFrom, rowsDict, type Registry } from "./detector";
import { parseFile, type FileMapping, type ParsedFile } from "./mapping";
import { query } from "./neo4j";
import { placeScenario, recomputePoints, touchedPoints } from "./storyTrees";
import { removeScenario, writeRows } from "./storyWriter";
import { validate, type Validation } from "./validator";

export type UploadedFile = { name: string; content: string };

export const MAX_FILE_BYTES = 2_000_000;

export async function loadRegistry(): Promise<Registry> {
  return registryFrom(await query(REGISTRY_CYPHER));
}

export function scenarioFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "batch";
  return `upload:${slug}`;
}

export function parseAll(files: UploadedFile[]): ParsedFile[] {
  return files.map((f) => {
    if (f.content.length > MAX_FILE_BYTES) throw new Error(`${f.name} is larger than 2 MB`);
    return parseFile(f.name, f.content);
  });
}

// Records already in Neo4j under another scenario (another batch, a set, or the history). IDs are
// deterministic per source record, but each scenario prefixes them, so the same files loaded as a
// second batch would duplicate every customer and decision. Same batch name = replace, which is fine.
async function alreadyLoaded(eventIds: string[], scenario: string) {
  const scenarios = (await query<{ s: string }>(
    `MATCH (e:Event) WITH DISTINCT e.scenario_id AS s WHERE s <> $scenario AND s <> 'live' RETURN s`, { scenario },
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

// Compare the files' records with what a batch already holds (same source IDs; same raw row = unchanged).
async function diffAgainst(scenario: string, events: Validation["events"]) {
  const stored = new Map((await query<{ id: string; payload: string }>(
    `MATCH (e:Event {scenario_id: $scenario}) RETURN e.event_id AS id, e.payload_json AS payload`, { scenario },
  )).map((r) => [r.id.slice(scenario.length + 1), r.payload]));
  let fresh = 0, changed = 0, unchanged = 0;
  for (const e of events) {
    const before = stored.get(e.event_id);
    if (before === undefined) fresh++;
    else if (before === JSON.stringify(e.raw)) unchanged++;
    else changed++;
  }
  const incoming = new Set(events.map((e) => e.event_id));
  const removed = [...stored.keys()].filter((id) => !incoming.has(id)).length;
  return { scenario, new: fresh, changed, unchanged, removed };
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
          `changed records` + (t.removed ? `; ${t.removed} records not in these files will be removed` : "") + "." });
  }
  return report;
}

export async function check(files: UploadedFile[], mappings: FileMapping[], name: string) {
  const report: Partial<Validation> = await validateAll(files, mappings, name, await loadRegistry());
  delete report.events;   // the client gets the report, not every mapped event
  return report;
}

// Validate again server-side (never trust the client's copy), then write and place in the trees.
export async function run(files: UploadedFile[], mappings: FileMapping[], name: string) {
  const registry = await loadRegistry();
  const report = await validateAll(files, mappings, name, registry);
  if (!report.ok) return { ok: false as const, error: "The mapping has validation errors", report: { ...report, events: undefined } };
  const t = report.target;
  if (t && t.new === 0 && t.changed === 0 && t.removed === 0) {
    return { ok: false as const, error: `Nothing new: all records are already loaded in ${t.scenario}.` };
  }
  const scenario = t?.scenario ?? scenarioFor(name);
  const touched = await touchedPoints(scenario);
  if (touched.length || (await query(`MATCH (e:Event {scenario_id: $scenario}) RETURN e LIMIT 1`, { scenario })).length) {
    await removeScenario(scenario);        // re-running a batch replaces it
    await recomputePoints(touched);
  }
  const rows = rowsDict(new Detector(registry, scenario).run(report.events));
  await writeRows(rows);
  const branches = await placeScenario(scenario);
  const customers = rows.entities.filter((e) => e.label === "Customer" && e.source_system === "stripe")
    .map((e) => (e.props as { email: string; name: string | null }))
    .map((p) => ({ email: p.email, name: p.name }));
  return { ok: true as const, scenario, counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])),
           customers, branches };
}

export async function listUploads() {
  return query<{ scenario: string; events: number; decisions: number; customers: number }>(
    `MATCH (e:Event) WHERE e.scenario_id STARTS WITH 'upload:'
     WITH e.scenario_id AS scenario, count(*) AS events
     OPTIONAL MATCH (d:Decision {scenario_id: scenario})
     WITH scenario, events, count(d) AS decisions
     OPTIONAL MATCH (c:Customer:Entity {scenario_id: scenario, source_system: 'stripe'})
     RETURN scenario, events, decisions, count(c) AS customers ORDER BY scenario`,
  );
}

export async function removeUpload(scenario: string) {
  if (!scenario.startsWith("upload:")) throw new Error("not an upload scenario");
  const touched = await touchedPoints(scenario);
  const removed = await removeScenario(scenario);
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
    `MATCH (c:Customer:Entity {source_system: 'stripe'}) WHERE c.scenario_id STARTS WITH 'upload:'
     OPTIONAL MATCH (c)<-[:ABOUT]-(:Decision)-[:ABOUT]->(t:Ticket)
     OPTIONAL MATCH (c)<-[:ABOUT]-(:Decision)-[:ABOUT]->(dp:Dispute)
     OPTIONAL MATCH (c)<-[:ABOUT]-(:Decision)-[:ABOUT]->(ch:Charge)
     WITH c, head(collect(DISTINCT t.subject)) AS subject, head(collect(DISTINCT dp.category)) AS dispute,
          max(ch.amount_usd) AS amount
     WHERE subject IS NOT NULL OR dispute IS NOT NULL
     RETURN c.scenario_id AS scenario, c.email AS email, c.name AS name, subject, dispute, amount
     ORDER BY scenario, name`,
  );
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
