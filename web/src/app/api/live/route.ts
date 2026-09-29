import { ingestLive, liveCustomerSummary, liveEvents, liveSummary, removeLiveCustomer } from "@/lib/live";

// GET /api/live: counts; ?events=1: the captured events and what each became; ?email=: one customer's live tickets.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const email = params.get("email");
  if (email) return Response.json(await liveCustomerSummary(email));
  return Response.json(params.has("events") ? await liveEvents() : await liveSummary());
}

// Re-run the live pipeline over everything captured (idempotent), e.g. after a detector change.
export async function POST() {
  return Response.json(await ingestLive([], { prune: true }));
}

// DELETE /api/live?email=: clear one customer's live decisions (nothing else).
export async function DELETE(request: Request) {
  const email = new URL(request.url).searchParams.get("email");
  if (!email) return Response.json({ error: "email is required" }, { status: 400 });
  return Response.json(await removeLiveCustomer(email));
}
