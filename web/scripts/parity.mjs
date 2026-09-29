// Parity test (demo spec §16.1): native adapter + TypeScript detector must reproduce the Python
// pipeline's rows exactly. Checks the six Events-tab sets (rows stored in the set files) and, if
// given, a raw-event JSONL plus the Python detector's rows for it.
//   node --env-file=../.env scripts/parity.mjs [events.jsonl python_rows.json scenario]
import { readFileSync } from "node:fs";
import neo4j from "neo4j-driver";
import { toContract } from "../src/lib/nativeAdapter.ts";
import { Detector, REGISTRY_CYPHER, registryFrom, rowsDict } from "../src/lib/detector.ts";

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) =>
    [k, k === "payload_json" ? canon(JSON.parse(v[k])) : canon(v[k])]));
  return v;
}
const key = (r) => JSON.stringify(canon(r));

// Port of stories.py subtract(): rows in `all` not in `first` (the "60 days later" delta).
function subtract(all, first) {
  const idKey = (t, r) => ["events", "decisions", "outcomes", "entities", "contexts"].includes(t)
    ? r.event_id ?? r.decision_id ?? r.outcome_id ?? r.entity_id ?? r.context_id : key(r);
  return Object.fromEntries(Object.entries(all).map(([t, rows]) => {
    const seen = new Set((first[t] ?? []).map((r) => idKey(t, r)));
    return [t, rows.filter((r) => !seen.has(idKey(t, r)))];
  }));
}

function diff(label, ts, py) {
  const problems = [];
  for (const t of new Set([...Object.keys(ts), ...Object.keys(py)])) {
    const a = (ts[t] ?? []).map(key), b = (py[t] ?? []).map(key);
    const bs = new Set(b), as = new Set(a);
    const onlyTs = a.filter((k) => !bs.has(k)), onlyPy = b.filter((k) => !as.has(k));
    if (onlyTs.length || onlyPy.length || a.length !== b.length) {
      problems.push(`  ${t}: ts=${a.length} py=${b.length}` +
        (onlyTs[0] ? `\n    only ts: ${onlyTs[0].slice(0, 400)}` : "") + (onlyPy[0] ? `\n    only py: ${onlyPy[0].slice(0, 400)}` : ""));
    }
  }
  const n = Object.values(py).reduce((s, rows) => s + rows.length, 0);
  console.log(problems.length ? `FAIL ${label}\n${problems.join("\n")}` : `ok   ${label} (${n} rows)`);
  return problems.length === 0;
}

// The Python rows predate the contract fields on Event rows (canonical_type, data_json); compare without them.
const detect = (reg, scenario, raw) => {
  const rows = rowsDict(new Detector(reg, scenario).run(raw.map(toContract).filter(Boolean)));
  rows.events = rows.events.map(({ canonical_type: _c, data_json: _d, ...rest }) => rest);
  return rows;
};

const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
const { records } = await driver.executeQuery(REGISTRY_CYPHER, {}, { database: process.env.NEO4J_DATABASE ?? "neo4j" });
await driver.close();
const reg = registryFrom(records.map((r) => ({ ...r.toObject(), window: r.get("window")?.toNumber?.() ?? r.get("window") })));

let pass = true;
for (let n = 1; n <= 6; n++) {
  const set = JSON.parse(readFileSync(new URL(`../src/data/stories/set-${n}.json`, import.meta.url)));
  const [p1, p2] = set.phases;
  const first = detect(reg, set.scenario_id, p1.events);
  const total = detect(reg, set.scenario_id, [...p1.events, ...p2.events]);
  pass = diff(`set ${n} · ${p1.name}`, first, p1.rows) && pass;
  pass = diff(`set ${n} · ${p2.name}`, subtract(total, first), p2.rows) && pass;
}
const [file, pyRows, scenario = "history"] = process.argv.slice(2);
if (file) {
  const raw = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const t0 = Date.now();
  const rows = detect(reg, scenario, raw);
  console.log(`     ${raw.length} raw events detected in ${Date.now() - t0} ms`);
  pass = diff(file.split("/").pop(), rows, JSON.parse(readFileSync(pyRows, "utf8"))) && pass;
}
console.log(pass ? "PARITY OK" : "PARITY FAILED");
process.exit(pass ? 0 : 1);
