import { z } from "zod";
import { profile } from "@/lib/mapping";
import { proposeMapping } from "@/lib/mappingAgent";
import { readParsed } from "@/lib/sources";
import { loadRegistry, parseAll } from "@/lib/uploads";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 120;

// An uploaded file (with its contents) or a Databricks table (a reference the server reads itself).
const Body = z.object({
  file: z.object({ name: z.string(), content: z.string() }).optional(),
  table: z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/), version: z.number().int().nonnegative() }).optional(),
}).refine((b) => !!b.file !== !!b.table, "send a file or a table");

// The mapping agent's proposal for one file (the Events tab calls this once per file, in parallel).
async function POST_(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    const file = body.data.table ? await readParsed(body.data.table) : parseAll([body.data.file!])[0];
    const started = Date.now();
    const mapping = await proposeMapping(file, await loadRegistry());
    return Response.json({ profile: profile(file), mapping, seconds: Math.round((Date.now() - started) / 100) / 10 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const POST = withTenant(POST_);
