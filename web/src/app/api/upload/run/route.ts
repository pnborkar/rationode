import { z } from "zod";
import { FileMappingSchema } from "@/lib/mapping";
import { resolve } from "@/lib/sources";
import { run } from "@/lib/uploads";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 300;

const Body = z.object({
  name: z.string().min(1),
  files: z.array(z.object({ name: z.string(), content: z.string() })).default([]),
  tables: z.array(z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/), version: z.number().int().nonnegative() })).default([]),
  mappings: z.array(FileMappingSchema),
  edited_files: z.array(z.string()).default([]),   // files whose mapping the reviewer changed
}).refine((b) => b.files.length + b.tables.length > 0, "no files or tables");

// Approve -> run: detector over the mapped events, written to Neo4j. Tables are read at the versions that
// were validated, and those versions are kept on the batch for the next (incremental) load.
async function POST_(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    const { files, tables, mappings, name, edited_files } = body.data;
    const result = await run(await resolve(files, tables), mappings, name, edited_files, tables);
    return Response.json(result, { status: result.ok ? 200 : 422 });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 422 });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const POST = withTenant(POST_);
