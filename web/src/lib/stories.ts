// Events-tab sets (demo spec Section 10.5): load, remove, reset.
import set1 from "../data/stories/set-1.json";
import set2 from "../data/stories/set-2.json";
import set3 from "../data/stories/set-3.json";
import set4 from "../data/stories/set-4.json";
import set5 from "../data/stories/set-5.json";
import set6 from "../data/stories/set-6.json";
import { query } from "./neo4j";
import { placeScenario, recomputePoints, touchedPoints, type BranchChange } from "./storyTrees";
import { removeScenario, writeRows, type Rows } from "./storyWriter";

type RawEvent = { event_id: string; source_system: string; event_type: string; occurred_at: string;
                  payload: Record<string, unknown> };
export type StorySet = {
  set: number; key: string; scenario_id: string; title: string; point: string; message: string; via_bank: boolean;
  customer: { name: string; email: string; plan: string; tenure_months: number };
  phases: { name: string; events: RawEvent[]; rows: Rows }[];
  became: Record<string, string[]>;
};

export const SETS = [set1, set2, set3, set4, set5, set6] as unknown as StorySet[];

export function getSet(n: number): StorySet {
  const s = SETS.find((x) => x.set === n);
  if (!s) throw new Error(`No set ${n}`);
  return s;
}

// What the customer says when their case is sent to the live agent (their ticket's words, or a set-specific line).
export function complaintText(s: StorySet): string {
  return s.message;
}

export async function status() {
  const loaded = await query<{ scenario: string; events: string[] }>(
    `MATCH (e:Event) WHERE e.scenario_id STARTS WITH 'story:'
     RETURN e.scenario_id AS scenario, collect(e.event_id) AS events`,
  );
  const byScenario = new Map(loaded.map((r) => [r.scenario, new Set(r.events)]));
  return SETS.map((s) => {
    const ids = byScenario.get(s.scenario_id) ?? new Set<string>();
    const has = (phase: number) => s.phases[phase].events.length > 0
      && s.phases[phase].events.every((e) => ids.has(`${s.scenario_id}|${e.event_id}`));
    return { set: s.set, key: s.key, loaded: has(0), outcomesLoaded: has(1) };
  });
}

export async function loadPhase(n: number, phase: number): Promise<BranchChange[]> {
  const s = getSet(n);
  if (phase === 1) await writeRows(s.phases[0].rows);   // "60 days later" needs the events in place first
  await writeRows(s.phases[phase].rows);
  return placeScenario(s.scenario_id);
}

export async function removeSet(n: number) {
  const s = getSet(n);
  const touched = await touchedPoints(s.scenario_id);
  const removed = await removeScenario(s.scenario_id);
  await recomputePoints(touched);
  return { removed, branchesRestored: touched.length };
}

// Remove every loaded set, uploaded batch, and the live tab's decisions; the history is never touched.
export async function resetAll() {
  const scenarios = (await query<{ s: string }>(
    `MATCH (d:Event) WHERE d.scenario_id STARTS WITH 'story:' OR d.scenario_id STARTS WITH 'upload:' OR d.scenario_id = 'live'
     RETURN DISTINCT d.scenario_id AS s`)).map((r) => r.s);
  for (const extra of ["live"]) if (!scenarios.includes(extra)) scenarios.push(extra);
  let removed = 0;
  const touched = new Set<string>();
  for (const sc of scenarios) {
    (await touchedPoints(sc)).forEach((p) => touched.add(p));
    removed += await removeScenario(sc);
  }
  await recomputePoints([...touched]);
  return { removed, scenarios, branchesRestored: touched.size };
}
