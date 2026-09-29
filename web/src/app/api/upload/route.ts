import { listUploads, removeUpload } from "@/lib/uploads";

export async function GET() {
  return Response.json(await listUploads());
}

// DELETE /api/upload?scenario=upload:<name>
export async function DELETE(request: Request) {
  const scenario = new URL(request.url).searchParams.get("scenario") ?? "";
  if (!scenario.startsWith("upload:")) return Response.json({ error: "scenario must be upload:<name>" }, { status: 400 });
  return Response.json(await removeUpload(scenario));
}
