// The workspace (tenant) of the current request (demo spec §23.9). One deployment serves several workspaces at
// /<workspace>; the proxy resolves the workspace from the path (after checking the access code opens it) and passes it
// on as the x-rationode-tenant request header, replacing any the client sent. Every API route runs inside
// `withTenant`, which keeps that workspace for the whole request (AsyncLocalStorage), so every query reads the right one.
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_TENANT, isValidWorkspaceId, isWorkspace, workspacePath } from "./workspaces";

export { DEFAULT_TENANT, isWorkspace, workspaces } from "./workspaces";

const store = new AsyncLocalStorage<string>();

export function tenantOf(request: Request): string {
  // Set by the proxy after checking the workspace exists and the code opens it (a client's header is replaced), so a
  // well-formed ID is trusted here (a workspace added in Settings may not be in this module's cache yet).
  const header = request.headers.get("x-rationode-tenant");
  return header && (isWorkspace(header) || isValidWorkspaceId(header)) ? header : DEFAULT_TENANT;
}

export const currentTenant = () => store.getStore() ?? DEFAULT_TENANT;

export function runInTenant<T>(tenant: string, fn: () => T): T {
  return store.run(tenant, fn);
}

// The current workspace's URL for one of the app's own API paths (server-to-server calls, e.g. the agent's gateway).
export const apiPath = (path: string) => workspacePath(currentTenant(), path);

// Wrap a route handler: the request's workspace for everything it does (streams included: they start inside it).
export function withTenant<A extends unknown[], R>(handler: (request: Request, ...rest: A) => R) {
  return (request: Request, ...rest: A): R => store.run(tenantOf(request), () => handler(request, ...rest));
}
