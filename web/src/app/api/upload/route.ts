import { listUploads, removeUpload } from "@/lib/uploads";
import { withTenant } from "@/lib/tenant";

async function GET_() {
  return Response.json(await listUploads());
}

// DELETE /api/upload?scenario=: the demo's upload:<name>, or a tenant's own loaded history (removeUpload decides).
async function DELETE_(request: Request) {
  const scenario = new URL(request.url).searchParams.get("scenario") ?? "";
  try {
    return Response.json(await removeUpload(scenario));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
export const DELETE = withTenant(DELETE_);
