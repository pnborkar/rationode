import { z } from "zod";
import { deleteScenario, listScenarios } from "@/lib/scenarios";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 300;

// GET: the scenarios this app may delete, with counts (the "Delete scenario" dropdown).
async function GET_() {
  return Response.json(await listScenarios());
}

// DELETE {scenario, confirm}: the scenario's name must be typed to confirm.
async function DELETE_(request: Request) {
  const body = z.object({ scenario: z.string(), confirm: z.string() }).safeParse(await request.json().catch(() => ({})));
  if (!body.success || body.data.confirm !== body.data.scenario) {
    return Response.json({ error: "Type the scenario's name to confirm" }, { status: 400 });
  }
  try {
    return Response.json(await deleteScenario(body.data.scenario));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
export const DELETE = withTenant(DELETE_);
