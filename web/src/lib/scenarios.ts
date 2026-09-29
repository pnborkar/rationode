// "Delete scenario" (demo spec §22): the scenarios this app may delete, and deleting one. The demo can delete
// its uploads, Events-tab sets and live decisions, never its history; a tenant can delete its own loaded
// history and its live decisions. Other tenants' data is never listed.
import { LIVE } from "./live";
import { IS_DEMO, query, SCENARIO } from "./neo4j";
import { recomputePoints, touchedPoints } from "./storyTrees";
import { removeScenario } from "./storyWriter";
import { removeTenantData, removeUpload } from "./uploads";

export type ScenarioInfo = { scenario: string; kind: string; events: number; decisions: number };

// Only this app's own scenarios: the demo's uploads, sets and live data; or this tenant's history and live data.
const kindOf = (s: string) =>
  s === LIVE ? "live decisions"
    : IS_DEMO ? (s.startsWith("upload:") ? "uploaded batch" : s.startsWith("story:") ? "Events-tab set" : null)
    : s === SCENARIO ? "loaded history (all of this tenant's data)" : null;

export async function listScenarios(): Promise<ScenarioInfo[]> {
  const rows = await query<{ scenario: string; events: number; decisions: number }>(
    `MATCH (e:Event) WHERE ($demo AND (e.scenario_id STARTS WITH 'upload:' OR e.scenario_id STARTS WITH 'story:' OR e.scenario_id = $live))
                        OR (NOT $demo AND e.scenario_id IN [$base, $live])
     WITH e.scenario_id AS scenario, count(e) AS events
     OPTIONAL MATCH (d:Decision {scenario_id: scenario})
     RETURN scenario, events, count(d) AS decisions ORDER BY scenario`,
    { demo: IS_DEMO, base: SCENARIO, live: LIVE });
  return rows.map((r) => ({ ...r, kind: kindOf(r.scenario)! })).filter((r) => r.kind);
}

export async function deleteScenario(scenario: string) {
  const kind = kindOf(scenario);
  if (!kind || scenario === "history") throw new Error(`${scenario} can't be deleted from this app`);
  if (scenario === SCENARIO && !IS_DEMO) return { scenario, ...(await removeTenantData()) };
  if (scenario.startsWith("upload:")) return { scenario, ...(await removeUpload(scenario)) };
  const touched = await touchedPoints(scenario);   // live decisions or a set: restore the tree branches they moved
  const removed = await removeScenario(scenario);
  await recomputePoints(touched);
  return { scenario, removed, branchesRestored: touched.length };
}
