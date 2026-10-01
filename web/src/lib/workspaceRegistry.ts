// Workspaces added in Settings (demo spec §23.9): stored in Neo4j as (:Workspace {id, name, created_at}) control-plane
// nodes (no scenario_id: they belong to no workspace) and treated as appended to RATIONODE_WORKSPACES. Each server
// module keeps the list cached for 30 seconds (the proxy checks it on every request).
import { query } from "./neo4j";
import { configuredWorkspaces, isValidWorkspaceId, setAddedWorkspaces, workspaces, type Workspace } from "./workspaces";

const TTL_MS = 30_000;
let loadedAt = 0;

export async function refreshWorkspaces(force = false) {
  if (!force && Date.now() - loadedAt < TTL_MS) return;
  try {
    setAddedWorkspaces(await query<Workspace>(`MATCH (w:Workspace) RETURN w.id AS id, w.name AS name ORDER BY w.created_at`));
    loadedAt = Date.now();
  } catch { /* Neo4j unreachable: keep the last list (the configured workspaces always work) */ }
}

export async function listWorkspaces() {
  await refreshWorkspaces(true);
  const configured = new Set(configuredWorkspaces().map((w) => w.id));
  const counts = new Map((await query<{ s: string; n: number }>(
    `UNWIND $ids AS s CALL (s) { MATCH (d:Decision {scenario_id: s}) RETURN count(d) AS n } RETURN s, n`,
    { ids: workspaces().map((w) => w.id) })).map((r) => [r.s, r.n]));
  return workspaces().map((w) => ({ ...w, from: configured.has(w.id) ? "configuration" : "settings", decisions: counts.get(w.id) ?? 0 }));
}

export async function addWorkspace(id: string, name: string) {
  const key = id.trim().toLowerCase();
  if (!isValidWorkspaceId(key)) throw new Error("ID: lower-case letters, digits, - or _, starting with a letter or digit (not api, login, samples)");
  await refreshWorkspaces(true);
  if (workspaces().some((w) => w.id === key)) throw new Error(`a workspace "${key}" already exists`);
  await query(`MERGE (w:Workspace {id: $id}) ON CREATE SET w.name = $name, w.created_at = datetime()`, { id: key, name: name.trim() || key });
  await refreshWorkspaces(true);
  return { id: key, name: name.trim() || key };
}

// Only workspaces added in Settings come off the list; their data stays (delete it first from the workspace's Settings).
export async function removeWorkspace(id: string) {
  if (configuredWorkspaces().some((w) => w.id === id)) throw new Error("this workspace comes from the configuration (RATIONODE_WORKSPACES)");
  await query(`MATCH (w:Workspace {id: $id}) DELETE w`, { id });
  await refreshWorkspaces(true);
}
