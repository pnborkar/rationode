import { z } from "zod";
import { databricksLoads, incremental, pendingRanges } from "@/lib/sources";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 300;

// GET: each Databricks load (a demo batch, or a workspace source) and which of its tables changed since (nothing is
// read but versions). `batch`/`ranges`: the first load with changes, or the latest.
async function GET_() {
  try {
    const loads = await Promise.all((await databricksLoads()).map(async (b) => ({
      batch: b.name, scenario: b.scenario, loaded_at: b.loadedAt, sources: b.sources, ranges: await pendingRanges(b) })));
    if (!loads.length) return Response.json({ batch: null, loads });
    return Response.json({ ...(loads.find((l) => l.ranges.length) ?? loads[0]), loads });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

const Body = z.object({
  apply: z.boolean().default(false),
  ranges: z.array(z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/), from: z.number().int().nonnegative(),
                             to: z.number().int().nonnegative() })).optional(),   // approve the ranges that were checked
  batch: z.string().optional(),   // which load (demo batch or workspace source); default: the latest
});

// POST: check (validator + dry run over the merged rows, nothing written) or apply the changes since the last load.
async function POST_(request: Request) {
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    const r = await incremental(body.data.apply, body.data.ranges, body.data.batch);
    return Response.json(r, { status: "error" in r ? 422 : 200 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
export const POST = withTenant(POST_);
