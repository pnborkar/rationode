// The workspace (tenant) of the current request (demo spec §23.9). One deployment serves several workspaces: every API
// route runs inside `withTenant`, which takes the workspace from the request (header set by the page, else the
// rn_tenant cookie the workspace dropdown sets, else the configured default) and keeps it for the whole request
// (AsyncLocalStorage), so every query reads the right one. Only listed workspaces are accepted.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

export const DEFAULT_TENANT = process.env.RATIONODE_TENANT?.trim() || "history";

// RATIONODE_WORKSPACES: "history:Streamly demo,lending:Lending (BPIC 2017)". The default is always allowed.
export function workspaces(): { id: string; name: string }[] {
  const listed = (process.env.RATIONODE_WORKSPACES ?? "").split(",").map((w) => w.trim()).filter(Boolean).map((w) => {
    const [id, ...name] = w.split(":");
    return { id: id.trim(), name: name.join(":").trim() || id.trim() };
  });
  const all = listed.some((w) => w.id === DEFAULT_TENANT) ? listed
    : [{ id: DEFAULT_TENANT, name: DEFAULT_TENANT === "history" ? "Streamly demo" : DEFAULT_TENANT }, ...listed];
  return all.map((w) => ({ ...w, name: w.id === "history" && w.name === "history" ? "Streamly demo" : w.name }));
}

export const isWorkspace = (id: string | null | undefined): id is string => !!id && workspaces().some((w) => w.id === id);

export function tenantOf(request: Request): string {
  const header = request.headers.get("x-rationode-tenant");
  if (isWorkspace(header)) return header;
  const cookie = /(?:^|;\s*)rn_tenant=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const fromCookie = cookie ? decodeURIComponent(cookie) : null;
  return isWorkspace(fromCookie) ? fromCookie : DEFAULT_TENANT;
}

export const currentTenant = () => store.getStore() ?? DEFAULT_TENANT;

export function runInTenant<T>(tenant: string, fn: () => T): T {
  return store.run(tenant, fn);
}

// Wrap a route handler: the request's workspace for everything it does (streams included: they start inside it).
export function withTenant<A extends unknown[], R>(handler: (request: Request, ...rest: A) => R) {
  return (request: Request, ...rest: A): R => store.run(tenantOf(request), () => handler(request, ...rest));
}
