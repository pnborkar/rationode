import { z } from "zod";
import { incremental, lastDatabricksLoad, pendingRanges } from "@/lib/sources";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 300;

// GET: the last load from Databricks and which tables changed since (nothing is read but versions).
async function GET_() {
  try {
    const batch = await lastDatabricksLoad();
    if (!batch) return Response.json({ batch: null });
    return Response.json({ batch: batch.name, scenario: batch.scenario, loaded_at: batch.loadedAt, sources: batch.sources,
                           ranges: await pendingRanges(batch) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

const Body = z.object({
  apply: z.boolean().default(false),
  ranges: z.array(z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/), from: z.number().int().nonnegative(),
                             to: z.number().int().nonnegative() })).optional(),   // approve the ranges that were checked
});

// POST: check (validator + dry run over the merged rows, nothing written) or apply the changes since the last load.
async function POST_(request: Request) {
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    const r = await incremental(body.data.apply, body.data.ranges);
    return Response.json(r, { status: "error" in r ? 422 : 200 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
export const POST = withTenant(POST_);
