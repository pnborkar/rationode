import { z } from "zod";
import { aiStatus, clearAi, saveAi } from "@/lib/settings";

// GET: the models in use (for labels such as the agent's thinking panel) and where the key comes from.
export async function GET() {
  return Response.json(await aiStatus());
}

const Body = z.object({ agentModel: z.string(), mappingModel: z.string(), apiKey: z.string().optional(), clearKey: z.boolean().optional() });

// PUT: save the tenant's models and, optionally, its own Anthropic key (blank keeps the saved key).
export async function PUT(request: Request) {
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
export async function DELETE() {
  await clearAi();
  return Response.json(await aiStatus());
}
