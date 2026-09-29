import { z } from "zod";
import { FileMappingSchema } from "@/lib/mapping";
import { check } from "@/lib/uploads";

const Body = z.object({
  name: z.string().min(1),
  files: z.array(z.object({ name: z.string(), content: z.string() })).min(1),
  mappings: z.array(FileMappingSchema),
});

// Validator + dry run: nothing is written.
export async function POST(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    return Response.json(await check(body.data.files, body.data.mappings, body.data.name));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
