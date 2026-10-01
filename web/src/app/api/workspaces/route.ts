import { z } from "zod";
import { addWorkspace, listWorkspaces, removeWorkspace } from "@/lib/workspaceRegistry";
import { accessFor } from "@/lib/workspaces";

// Settings → Workspaces (§23.9): only the master code may list, add or remove workspaces (a workspace's own code never
// sees the others). Workspaces added here are appended to RATIONODE_WORKSPACES.
function master(request: Request) {
  const cookie = /(?:^|;\s*)rn_access=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  return accessFor(cookie ? decodeURIComponent(cookie) : null) === "all" || accessFor(bearer) === "all";
}
const forbidden = () => Response.json({ error: "only the master access code manages workspaces" }, { status: 403 });

export async function GET(request: Request) {
  if (!master(request)) return forbidden();
  return Response.json(await listWorkspaces());
}

export async function POST(request: Request) {
  if (!master(request)) return forbidden();
  const body = z.object({ id: z.string(), name: z.string().default("") }).safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try { return Response.json(await addWorkspace(body.data.id, body.data.name)); }
  catch (err) { return Response.json({ error: (err as Error).message }, { status: 400 }); }
}

export async function DELETE(request: Request) {
  if (!master(request)) return forbidden();
  const id = new URL(request.url).searchParams.get("id") ?? "";
  try { await removeWorkspace(id); return Response.json({ removed: id }); }
  catch (err) { return Response.json({ error: (err as Error).message }, { status: 400 }); }
}
