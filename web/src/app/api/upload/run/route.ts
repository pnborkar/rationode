import { z } from "zod";
import { FileMappingSchema } from "@/lib/mapping";
import { run } from "@/lib/uploads";

export const maxDuration = 60;

const Body = z.object({
  name: z.string().min(1),
  files: z.array(z.object({ name: z.string(), content: z.string() })).min(1),
  mappings: z.array(FileMappingSchema),
  edited_files: z.array(z.string()).default([]),   // files whose mapping the reviewer changed
});

// Approve -> run: detector over the mapped events, written to Neo4j under upload:<name>.
export async function POST(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  const result = await run(body.data.files, body.data.mappings, body.data.name, body.data.edited_files);
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
