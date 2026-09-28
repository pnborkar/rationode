import { z } from "zod";
import { getSet, loadPhase, removeSet } from "@/lib/stories";

type Ctx = { params: Promise<{ set: string }> };
const Body = z.object({ phase: z.union([z.literal(0), z.literal(1)]) });

// Load a set's events (phase 0) or its "60 days later" outcomes (phase 1).
export async function POST(request: Request, { params }: Ctx) {
  const n = Number((await params).set);
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  const s = getSet(n);
  const branches = await loadPhase(n, body.data.phase);
  const phase = s.phases[body.data.phase];
  return Response.json({
    set: n, phase: phase.name, scenario_id: s.scenario_id,
    events: phase.events.map((e) => ({ ...e, became: s.became[e.event_id] ?? [] })),
    story: { key: s.key, title: s.title, point: s.point, customer: s.customer },
    branches,
  });
}

export async function DELETE(_request: Request, { params }: Ctx) {
  return Response.json(await removeSet(Number((await params).set)));
}
