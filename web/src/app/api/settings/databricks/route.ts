import { z } from "zod";
import { clearDatabricks, databricksStatus, saveDatabricks } from "@/lib/settings";
import { withTenant } from "@/lib/tenant";

const Body = z.object({ host: z.string(), warehouse: z.string(), schema: z.string(), token: z.string().optional() });

// PUT: save this tenant's Databricks connection (a blank token keeps the saved one for the same host).
async function PUT_(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    await saveDatabricks(body.data);
    return Response.json(await databricksStatus());
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

// DELETE: forget the saved connection (the environment's DATABRICKS_*, if any, applies again).
async function DELETE_() {
  await clearDatabricks();
  return Response.json(await databricksStatus());
}

// Every request runs in its workspace (demo spec §23.9).
export const PUT = withTenant(PUT_);
export const DELETE = withTenant(DELETE_);
