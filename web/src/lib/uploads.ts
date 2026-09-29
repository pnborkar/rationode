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

export async function check(files: UploadedFile[], mappings: FileMapping[], name: string) {
  const report: Partial<Validation> = validate(parseAll(files), mappings, await loadRegistry(), scenarioFor(name));
  delete report.events;   // the client gets the report, not every mapped event
  return report;
}

// Validate again server-side (never trust the client's copy), then write and place in the trees.
export async function run(files: UploadedFile[], mappings: FileMapping[], name: string) {
  const scenario = scenarioFor(name);
  const registry = await loadRegistry();
  const report = validate(parseAll(files), mappings, registry, scenario);
  if (!report.ok) return { ok: false as const, error: "The mapping has validation errors", report: { ...report, events: undefined } };
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
