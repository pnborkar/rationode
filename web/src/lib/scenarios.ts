// "Delete scenario" (demo spec §22): the scenarios this app may delete, and deleting one. The demo can delete
// its uploads, Events-tab sets and live decisions, never its history; a workspace can delete one of its sources
// (§23.9), all its loaded data, or its live decisions. Other workspaces' data is never listed.
import { liveScenario } from "./live";
import { demoMode, query, baseScenario } from "./neo4j";
import { recomputePoints, touchedPoints } from "./storyTrees";
import { resetAll } from "./stories";
import { removeScenario } from "./storyWriter";
import { listSources, removeSource, removeTenantData, removeUpload } from "./uploads";

// The scenarios this app may look at (Browse, graphs): never another tenant's.
export const ownScenario = (s: string) =>
  demoMode() ? s === "history" || s === liveScenario() || s.startsWith("story:") || s.startsWith("upload:") : s === baseScenario() || s === liveScenario();

export type ScenarioInfo = { scenario: string; kind: string; events: number; decisions: number };

// The demo's "everything loaded" entry (what the old one-click Reset all did): all sets, uploads and live
// decisions at once; the history stays. A tenant has no such entry (its live decisions are one entry already).
export const EVERYTHING = "everything";

// Only this app's own scenarios: the demo's uploads, sets and live data; or this tenant's history and live data.
const kindOf = (s: string) =>
  s === liveScenario() ? "live decisions"
    : demoMode() ? (s.startsWith("upload:") ? "uploaded batch" : s.startsWith("story:") ? "Events-tab set" : null)
    : s === baseScenario() ? "loaded history (all of this tenant's data)" : null;

// A workspace's source, as a Delete scenario entry.
const SOURCE = "source:";

export async function listScenarios(): Promise<ScenarioInfo[]> {
  const rows = await query<{ scenario: string; events: number; decisions: number }>(
    `MATCH (e:Event) WHERE ($demo AND (e.scenario_id STARTS WITH 'upload:' OR e.scenario_id STARTS WITH 'story:' OR e.scenario_id = $live))
                        OR (NOT $demo AND e.scenario_id IN [$base, $live])
     WITH e.scenario_id AS scenario, count(e) AS events
     OPTIONAL MATCH (d:Decision {scenario_id: scenario})
     RETURN scenario, events, count(d) AS decisions ORDER BY scenario`,
    { demo: demoMode(), base: baseScenario(), live: liveScenario() });
  const list = rows.map((r) => ({ ...r, kind: kindOf(r.scenario)! })).filter((r) => r.kind);
  if (!demoMode()) {
    const sources = await listSources();
    return [...(sources.length > 1 ? sources.map((x) => ({ scenario: `${SOURCE}${x.source}`, events: x.events, decisions: x.decisions,
                                                            kind: "one source (the other sources stay)" })) : []), ...list];
  }
  if (!list.length) return list;
  const sets = list.filter((r) => r.scenario.startsWith("story:")).length, uploads = list.filter((r) => r.scenario.startsWith("upload:")).length;
  const everything = { scenario: EVERYTHING, events: list.reduce((n, r) => n + r.events, 0), decisions: list.reduce((n, r) => n + r.decisions, 0),
    kind: `everything loaded: ${sets} set${sets === 1 ? "" : "s"}, ${uploads} upload${uploads === 1 ? "" : "s"}` +
          `${list.some((r) => r.scenario === liveScenario()) ? ", live decisions" : ""} (history stays)` };
  return [everything, ...list];
}

export async function deleteScenario(scenario: string) {
  if (scenario === EVERYTHING && demoMode()) return { scenario, ...(await resetAll()) };
  if (scenario.startsWith(SOURCE) && !demoMode()) return { scenario, ...(await removeSource(scenario.slice(SOURCE.length))) };
  const kind = kindOf(scenario);
  if (!kind || scenario === "history") throw new Error(`${scenario} can't be deleted from this app`);
  if (scenario === baseScenario() && !demoMode()) return { scenario, ...(await removeTenantData()) };
  if (scenario.startsWith("upload:")) return { scenario, ...(await removeUpload(scenario)) };
  const touched = await touchedPoints(scenario);   // live decisions or a set: restore the tree branches they moved
  const removed = await removeScenario(scenario);
  await recomputePoints(touched);
  return { scenario, removed, branchesRestored: touched.length };
}
