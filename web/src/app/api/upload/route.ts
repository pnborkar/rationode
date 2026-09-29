import { listUploads, removeUpload } from "@/lib/uploads";

export async function GET() {
  return Response.json(await listUploads());
}

// DELETE /api/upload?scenario=: the demo's upload:<name>, or a tenant's own loaded history (removeUpload decides).
export async function DELETE(request: Request) {
  const scenario = new URL(request.url).searchParams.get("scenario") ?? "";
  try {
    return Response.json(await removeUpload(scenario));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
