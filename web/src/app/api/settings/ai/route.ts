import { z } from "zod";
import { aiStatus, clearAi, saveAi } from "@/lib/settings";
import { withTenant } from "@/lib/tenant";

// GET: the models in use (for labels such as the agent's thinking panel) and where the key comes from.
async function GET_() {
  return Response.json(await aiStatus());
}

const Body = z.object({ agentModel: z.string(), mappingModel: z.string(), apiKey: z.string().optional(), clearKey: z.boolean().optional() });

// PUT: save the tenant's models and, optionally, its own Anthropic key (blank keeps the saved key).
async function PUT_(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    await saveAi(body.data);
    return Response.json(await aiStatus());
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

// DELETE: back to the environment's model and key.
async function DELETE_() {
  await clearAi();
  return Response.json(await aiStatus());
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
export const PUT = withTenant(PUT_);
export const DELETE = withTenant(DELETE_);
