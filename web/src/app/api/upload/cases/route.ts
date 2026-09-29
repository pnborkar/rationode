import { uploadedCases } from "@/lib/uploads";

export async function GET() {
  return Response.json(await uploadedCases());
}
