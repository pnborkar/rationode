// A workspace's decision model (demo spec §22.1): the business settings an admin sees and changes in Settings. This
// first slice: the outcome window (a workspace default, and overrides per outcome type) and good / bad per outcome
// type. Stored per workspace (a window set here never changes another workspace's), every change recorded, and a
// change previewed (what it would credit differently) before it's saved and the workspace re-processed.
import { demoMode, query, baseScenario } from "./neo4j";

export const DEFAULT_WINDOW_DAYS = 90;

export type DecisionModel = { defaultWindow: number; windows: Record<string, number>; polarities: Record<string, "good" | "bad"> };

const EMPTY: DecisionModel = { defaultWindow: DEFAULT_WINDOW_DAYS, windows: {}, polarities: {} };

export async function getModel(): Promise<DecisionModel> {
  if (demoMode()) return EMPTY;
  const [r] = await query<{ json: string | null }>(
    `MATCH (t:TenantConfig {tenant: $tenant, kind: 'model'}) RETURN t.model_json AS json`, { tenant: baseScenario() });
  return r?.json ? { ...EMPTY, ...JSON.parse(r.json) } : EMPTY;
}

// Save the model and record each change (who: the access level; when; from; to).
export async function saveModel(next: DecisionModel, by = "Settings") {
  const before = await getModel();
  const changes: { key: string; from: string; to: string }[] = [];
  if (before.defaultWindow !== next.defaultWindow) changes.push({ key: "default outcome window", from: `${before.defaultWindow} days`, to: `${next.defaultWindow} days` });
  for (const t of new Set([...Object.keys(before.windows), ...Object.keys(next.windows)])) {
    if (before.windows[t] !== next.windows[t]) changes.push({ key: `window · ${t}`, from: before.windows[t] ? `${before.windows[t]} days` : "default",
                                                              to: next.windows[t] ? `${next.windows[t]} days` : "default" });
  }
  for (const t of new Set([...Object.keys(before.polarities), ...Object.keys(next.polarities)])) {
    if (before.polarities[t] !== next.polarities[t]) changes.push({ key: `good / bad · ${t}`, from: before.polarities[t] ?? "from the data",
                                                                    to: next.polarities[t] ?? "from the data" });
  }
  if (!changes.length) return changes;
  await query(
    `MERGE (t:TenantConfig {tenant: $tenant, kind: 'model'}) SET t.model_json = $json, t.updated_at = datetime()
     WITH t UNWIND $changes AS c
     CREATE (:SettingChange {tenant: $tenant, key: c.key, from: c.from, to: c.to, by: $by, at: datetime()})`,
    { tenant: baseScenario(), json: JSON.stringify(next), changes, by });
  return changes;
}

export async function history(limit = 15) {
  return query<{ key: string; from: string; to: string; by: string; at: string }>(
    `MATCH (c:SettingChange {tenant: $tenant}) RETURN c.key AS key, c.from AS from, c.to AS to, c.by AS by, toString(c.at) AS at
     ORDER BY c.at DESC LIMIT toInteger($limit)`, { tenant: baseScenario(), limit });
}

// Each outcome type in the workspace, as things stand: how many, how many credited to a decision (and how many of
// those outside the window), how many credited to none, and what the data says about good / bad.
export async function outcomeTypes() {
  return query<{ type: string; n: number; credited: number; outside: number; polarities: string[] }>(
    `MATCH (o:Outcome {scenario_id: $s})
     OPTIONAL MATCH (:Decision)-[l:LED_TO]->(o)
     WITH o, count(l) > 0 AS credited, any(x IN collect(l) WHERE x.outside_window = true) AS outside
     RETURN o.outcome_type AS type, count(o) AS n, sum(CASE WHEN credited THEN 1 ELSE 0 END) AS credited,
            sum(CASE WHEN outside THEN 1 ELSE 0 END) AS outside, collect(DISTINCT o.polarity) AS polarities
     ORDER BY n DESC`, { s: baseScenario() });
}
