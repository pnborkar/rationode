import { ingestLive, liveCustomerSummary, liveEvents, liveSummary, removeLiveCustomer } from "@/lib/live";
import { withTenant } from "@/lib/tenant";

// GET /api/live: counts; ?events=1: the captured events and what each became; ?email=: one customer's live tickets.
async function GET_(request: Request) {
  const params = new URL(request.url).searchParams;
  // ?email= with no customer selected (a tenant with no customers yet) is still a customer query.
  if (params.has("email")) {
    const email = params.get("email")!.trim();
    return Response.json(email ? await liveCustomerSummary(email) : { tickets: [], decisions: 0 });
  }
  return Response.json(params.has("events") ? await liveEvents() : await liveSummary());
}

// Re-run the live pipeline over everything captured (idempotent), e.g. after a detector change.
async function POST_() {
  return Response.json(await ingestLive([], { prune: true }));
}

// DELETE /api/live?email=: clear one customer's live decisions (nothing else).
async function DELETE_(request: Request) {
  const email = new URL(request.url).searchParams.get("email");
  if (!email) return Response.json({ error: "email is required" }, { status: 400 });
  return Response.json(await removeLiveCustomer(email));
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
export const POST = withTenant(POST_);
export const DELETE = withTenant(DELETE_);
