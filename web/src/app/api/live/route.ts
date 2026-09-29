import { ingestLive, liveEvents, liveSummary } from "@/lib/live";

// GET /api/live: counts; GET /api/live?events=1: the captured events and what each became.
export async function GET(request: Request) {
  const detail = new URL(request.url).searchParams.has("events");
  return Response.json(detail ? await liveEvents() : await liveSummary());
}

// Re-run the live pipeline over everything captured (idempotent), e.g. after a detector change.
export async function POST() {
  return Response.json(await ingestLive([]));
}
