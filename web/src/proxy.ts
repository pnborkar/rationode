import { NextResponse, type NextRequest } from "next/server";
import { refreshWorkspaces } from "@/lib/workspaceRegistry";
import { accessFor, DEFAULT_TENANT, isWorkspace, opens, workspacePath } from "@/lib/workspaces";

export const ACCESS_COOKIE = "rn_access";

// Every page and API route needs an access code (the demo spends API credit), and each workspace lives at its own path
// (demo spec §23.9): /<workspace> for the app, /<workspace>/api/… for its API, / for the default workspace. The proxy
// resolves the workspace from the path, checks the code opens it, and passes it on as a request header (replacing any
// the client sent), rewriting /<workspace>/… to the app's own routes.
export async function proxy(request: NextRequest) {
  await refreshWorkspaces();   // workspaces added in Settings (cached 30 s)
  const { pathname, search } = request.nextUrl;
  const first = pathname.split("/")[1] ?? "";
  // /history → / (the default workspace has no prefix).
  if (first === DEFAULT_TENANT) return NextResponse.redirect(new URL(pathname.slice(first.length + 1) || "/", request.url));
  const workspace = isWorkspace(first) ? first : DEFAULT_TENANT;
  const rest = workspace === DEFAULT_TENANT ? pathname : pathname.slice(first.length + 1) || "/";
  const isApi = rest.startsWith("/api/");

  // MCP clients and webhooks can't hold the browser cookie: they send the code as a bearer token.
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const access = accessFor(request.cookies.get(ACCESS_COOKIE)?.value) ?? accessFor(bearer);
  if (!opens(access, workspace)) {
    if (isApi) return Response.json({ error: access ? "this access code doesn't open this workspace" : "access code required" },
                                     { status: access ? 403 : 401 });
    // A code for one workspace landing on the default one: take it to its own.
    if (access && rest === "/" && workspace === DEFAULT_TENANT) return NextResponse.redirect(new URL(workspacePath(access), request.url));
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    if (access) login.searchParams.set("error", "workspace");
    return NextResponse.redirect(login);
  }

  const headers = new Headers(request.headers);
  headers.set("x-rationode-tenant", workspace);
  if (workspace === DEFAULT_TENANT) return NextResponse.next({ request: { headers } });
  return NextResponse.rewrite(new URL(rest + search, request.url), { request: { headers } });
}

export const config = {
  matcher: ["/((?!login|api/login|api/health|_next/static|_next/image|favicon.ico).*)"],
};
