// The workspaces one deployment serves and which access code opens which (demo spec §23.9). Pure (environment only),
// so the proxy, the layout and the route wrapper share it. A workspace lives at /<id> (its API at /<id>/api/…); the
// default workspace at /.
//   RATIONODE_WORKSPACES       "history:Streamly demo,lending:Lending (BPIC 2017)" (the default is always included)
//   DEMO_ACCESS_CODE           the master code: opens every workspace
//   RATIONODE_WORKSPACE_CODES  "lending:<code>,acme:<code>": a code that opens only that workspace
export const DEFAULT_TENANT = process.env.RATIONODE_TENANT?.trim() || "history";

// First path segments the app itself uses: never workspace IDs.
const RESERVED = new Set(["api", "login", "samples", "_next", "favicon.ico"]);
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export type Workspace = { id: string; name: string };

export function workspaces(): Workspace[] {
  const listed = (process.env.RATIONODE_WORKSPACES ?? "").split(",").map((w) => w.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
    .map((w) => { const [id, ...name] = w.split(":"); return { id: id.trim(), name: name.join(":").trim() || id.trim() }; })
    .filter((w) => VALID_ID.test(w.id) && !RESERVED.has(w.id));
  const all = listed.some((w) => w.id === DEFAULT_TENANT) ? listed
    : [{ id: DEFAULT_TENANT, name: DEFAULT_TENANT === "history" ? "Streamly demo" : DEFAULT_TENANT }, ...listed];
  return all.map((w) => ({ ...w, name: w.id === "history" && w.name === "history" ? "Streamly demo" : w.name }));
}

export const isWorkspace = (id: string | null | undefined): id is string => !!id && workspaces().some((w) => w.id === id);

// Where a workspace's page (or one of its API paths) lives.
export const workspacePath = (id: string, path = "") => (id === DEFAULT_TENANT ? path || "/" : `/${id}${path}`);

// What an access code opens: every workspace (the master code), one workspace, or nothing.
export function accessFor(code: string | null | undefined): "all" | string | null {
  const c = code?.trim();
  if (!c) return null;
  const master = process.env.DEMO_ACCESS_CODE?.trim();
  if (master && c === master) return "all";
  for (const pair of (process.env.RATIONODE_WORKSPACE_CODES ?? "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0 && pair.slice(i + 1).trim() === c && isWorkspace(pair.slice(0, i).trim())) return pair.slice(0, i).trim();
  }
  return null;
}

export const opens = (access: "all" | string | null, workspace: string) => access === "all" || access === workspace;

// The workspaces a code may switch between (the dropdown).
export const visibleWorkspaces = (access: "all" | string | null) =>
  access === "all" ? workspaces() : workspaces().filter((w) => w.id === access);
