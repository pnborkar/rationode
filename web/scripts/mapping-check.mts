// Mapping check: the sample exports through a mapping (e.g. the mapping agent's proposal) must give
// the same decision graph as the same batch's raw events through the native adapter.
//   npx tsx --env-file=../.env scripts/mapping-check.mts mappings.json
// (raw events: data/generated/sample_upload_raw.jsonl, from `uv run python -m rationode.sim.uploads`)
import { readFileSync } from "node:fs";
import neo4j from "neo4j-driver";
import { Detector, REGISTRY_CYPHER, registryFrom, rowsDict } from "../src/lib/detector";
import { mapFile, parseFile, type FileMapping } from "../src/lib/mapping";
import { toContract, type RawEvent } from "../src/lib/nativeAdapter";
import type { ContractEvent } from "../src/lib/contract";

const DIR = new URL("../public/samples/streamly-spring/", import.meta.url);
const mappings: FileMapping[] = JSON.parse(readFileSync(process.argv[2], "utf8"));

const driver = neo4j.driver(process.env.NEO4J_URI!, neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!));
const { records } = await driver.executeQuery(REGISTRY_CYPHER, {}, { database: process.env.NEO4J_DATABASE ?? "neo4j" });
await driver.close();
type RegistryRecord = Parameters<typeof registryFrom>[0][number];
const reg = registryFrom(records.map((r) => ({ ...r.toObject(), window: r.get("window")?.toNumber?.() ?? r.get("window") }) as RegistryRecord));

const raw: RawEvent[] = readFileSync(new URL("../../data/generated/sample_upload_raw.jsonl", import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const native = rowsDict(new Detector(reg, "upload:check").run(raw.map(toContract).filter((e): e is ContractEvent => !!e)));
const mapped = rowsDict(new Detector(reg, "upload:check").run(mappings.flatMap((m) =>
  mapFile(parseFile(m.file, readFileSync(new URL(m.file, DIR), "utf8")), m).events.map((x) => x.event))));

// Compare the graph, not the provenance: Event rows differ by design (source type, payload = the CSV row).
const drop = (t: string, r: Record<string, unknown>) => {
  const { payload_json: _p, event_type: _t, source_system: _s, data_json: _d, ...rest } = r;
  // Actor labels (name, version) are only as good as what the export carries; identity and kind must match.
  return t === "events" ? rest : t === "decisions" ? { ...r, source_system: undefined }
    : t === "actors" ? { actor_id: r.actor_id, kind: r.kind } : r;
};
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
let ok = true;
for (const t of Object.keys(native)) {
  const a = new Set(native[t].map((r) => JSON.stringify(canon(drop(t, r)))));
  const b = mapped[t].map((r) => JSON.stringify(canon(drop(t, r))));
  const onlyMapped = b.filter((k) => !a.has(k)), bs = new Set(b), onlyNative = [...a].filter((k) => !bs.has(k));
  const same = !onlyMapped.length && !onlyNative.length && a.size === b.length;
  ok &&= same;
  console.log(`${same ? "ok  " : "DIFF"} ${t}: native ${native[t].length}, mapped ${mapped[t].length}`);
  if (!same) {
    if (onlyNative[0]) console.log(`     native only: ${onlyNative[0].slice(0, 500)}`);
    if (onlyMapped[0]) console.log(`     mapped only: ${onlyMapped[0].slice(0, 500)}`);
  }
}
const labels = new Map(native.actors.map((a) => [a.actor_id, `${a.name} ${a.version ?? ""}`.trim()]));
for (const a of mapped.actors) {
  const theirs = `${a.name} ${a.version ?? ""}`.trim();
  if (labels.get(a.actor_id) !== theirs) console.log(`info actor label ${a.actor_id}: native "${labels.get(a.actor_id)}", mapped "${theirs}"`);
}
console.log(ok ? "MAPPING MATCHES NATIVE" : "MAPPING DIFFERS");
