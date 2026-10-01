import { z } from "zod";
import { FileMappingSchema } from "@/lib/mapping";
import { resolve } from "@/lib/sources";
import { check } from "@/lib/uploads";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 120;

// Uploaded files come with their contents; Databricks tables as references the server reads itself (§21.2).
const Body = z.object({
  name: z.string().min(1),
  files: z.array(z.object({ name: z.string(), content: z.string() })).default([]),
  tables: z.array(z.object({ table: z.string().regex(/^[A-Za-z0-9_]+$/), version: z.number().int().nonnegative() })).default([]),
  mappings: z.array(FileMappingSchema),
  windows: z.record(z.string(), z.number().int().min(1).max(3650)).default({}),   // outcome type -> window (days), §23.11
}).refine((b) => b.files.length + b.tables.length > 0, "no files or tables");

// Validator + dry run: nothing is written.
async function POST_(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    return Response.json(await check(await resolve(body.data.files, body.data.tables), body.data.mappings, body.data.name, body.data.windows));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const POST = withTenant(POST_);
