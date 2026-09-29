import { liveSummary } from "@/lib/live";

export async function GET() {
  return Response.json(await liveSummary());
}
