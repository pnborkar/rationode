import { z } from "zod";
import { getModel, history, outcomeTypes } from "@/lib/decisionModel";
import { demoMode } from "@/lib/neo4j";
import { applyModel, previewModel } from "@/lib/uploads";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 300;

// GET: the workspace's decision model (§22.1) with its outcome types as they stand, and the change history.
async function GET_() {
  if (demoMode()) return Response.json({ available: false });
  const [model, types, changes] = await Promise.all([getModel(), outcomeTypes(), history()]);
  return Response.json({ available: true, model, types, history: changes });
}

const Model = z.object({
  defaultWindow: z.number().int().min(1).max(3650),
  windows: z.record(z.string(), z.number().int().min(1).max(3650)),
  polarities: z.record(z.string(), z.enum(["good", "bad"])),
});
const Body = z.object({ action: z.enum(["preview", "apply"]), model: Model });

// POST {action: preview}: what the changed model would credit differently (nothing written).
// POST {action: apply}: save it (recorded) and re-process the workspace.
async function POST_(request: Request) {
  if (demoMode()) return Response.json({ error: "the demo's decision model isn't configurable here" }, { status: 400 });
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    return Response.json(body.data.action === "preview" ? await previewModel(body.data.model) : await applyModel(body.data.model));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
export const POST = withTenant(POST_);
