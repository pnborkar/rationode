// The browser's workspace (demo spec §23.9). The layout puts the workspace this page was loaded for on window (from
// the rn_tenant cookie the dropdown sets); every API call from this page is tagged with it (one fetch wrapper), so
// two tabs on different workspaces never mix. Switching sets the cookie and reloads.
declare global {
  interface Window { __RN_TENANT__?: string; __RN_WORKSPACES__?: { id: string; name: string }[]; __rnFetchTagged?: boolean }
}

const fallback = process.env.NEXT_PUBLIC_RATIONODE_TENANT ?? "history";
export const WORKSPACE: string = typeof window !== "undefined" ? window.__RN_TENANT__ ?? fallback : fallback;
export const WORKSPACE_IS_DEMO = WORKSPACE === "history";
export const WORKSPACES: { id: string; name: string }[] =
  (typeof window !== "undefined" && window.__RN_WORKSPACES__) || [{ id: WORKSPACE, name: WORKSPACE }];
export const workspaceName = (id = WORKSPACE) => WORKSPACES.find((w) => w.id === id)?.name ?? (id === "history" ? "Streamly demo" : id);

if (typeof window !== "undefined" && !window.__rnFetchTagged) {
  window.__rnFetchTagged = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith("/") ? url : url.startsWith(window.location.origin) ? url.slice(window.location.origin.length) : null;
    if (path?.startsWith("/api/")) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("x-rationode-tenant", WORKSPACE);
      return original(input, { ...init, headers });
    }
    return original(input, init);
  };
}

export function switchWorkspace(id: string) {
  document.cookie = `rn_tenant=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
  window.location.reload();
}
