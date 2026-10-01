// The browser's workspace (demo spec §23.9). The page is served at /<workspace> (the default workspace at /); the
// layout puts that workspace on window, and every API call from this page goes to /<workspace>/api/… (one fetch
// wrapper), so two tabs on different workspaces never mix. Switching workspace is a navigation.
declare global {
  interface Window { __RN_TENANT__?: string; __RN_DEFAULT__?: string; __RN_WORKSPACES__?: { id: string; name: string }[]; __rnFetchTagged?: boolean }
}

const fallback = process.env.NEXT_PUBLIC_RATIONODE_TENANT ?? "history";
const browser = typeof window !== "undefined";
export const WORKSPACE: string = browser ? window.__RN_TENANT__ ?? fallback : fallback;
const DEFAULT_WORKSPACE: string = browser ? window.__RN_DEFAULT__ ?? fallback : fallback;
export const WORKSPACE_IS_DEMO = WORKSPACE === "history";
export const WORKSPACES: { id: string; name: string }[] = (browser && window.__RN_WORKSPACES__) || [{ id: WORKSPACE, name: WORKSPACE }];
export const workspaceName = (id = WORKSPACE) => WORKSPACES.find((w) => w.id === id)?.name ?? (id === "history" ? "Streamly demo" : id);

// Where a workspace's page lives.
export const workspaceHref = (id: string) => (id === DEFAULT_WORKSPACE ? "/" : `/${id}`);

if (browser && !window.__rnFetchTagged && WORKSPACE !== DEFAULT_WORKSPACE) {
  window.__rnFetchTagged = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith("/") ? url : url.startsWith(window.location.origin) ? url.slice(window.location.origin.length) : null;
    if (path?.startsWith("/api/")) {
      const target = `/${WORKSPACE}${path}`;
      return original(input instanceof Request ? new Request(target, input) : target, init);
    }
    return original(input, init);
  };
}

export function switchWorkspace(id: string) {
  window.location.href = workspaceHref(id);
}
