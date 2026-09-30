import { analysisStatus, listSources, listUploads, removeUpload } from "@/lib/uploads";
import { demoMode } from "@/lib/neo4j";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 300;

// GET: the demo's upload batches, or a workspace's sources (§23.9), with counts. ?analysis=1: whether the workspace's
// trees and similar-case links predate its latest source change.
async function GET_(request: Request) {
  if (new URL(request.url).searchParams.has("analysis")) return Response.json(await analysisStatus());
  if (demoMode()) return Response.json(await listUploads());
  const [base] = await listUploads();
  return Response.json((await listSources()).map((s) => ({ scenario: base?.scenario, source: s.source, events: s.events,
                                                           decisions: s.decisions, customers: 0, files: s.files, loaded_at: s.loaded_at })));
}

// DELETE /api/upload?scenario=[&source=]: the demo's upload:<name>, or one source of a workspace (removeUpload decides).
async function DELETE_(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    return Response.json(await removeUpload(params.get("scenario") ?? "", params.get("source") ?? undefined));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
export const DELETE = withTenant(DELETE_);
