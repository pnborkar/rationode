import { z } from "zod";
import { profile } from "@/lib/mapping";
import { proposeMapping } from "@/lib/mappingAgent";
import { loadRegistry, parseAll } from "@/lib/uploads";

export const maxDuration = 120;

const Body = z.object({ file: z.object({ name: z.string(), content: z.string() }) });

// The mapping agent's proposal for one file (the Events tab calls this once per file, in parallel).
export async function POST(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    const [file] = parseAll([body.data.file]);
    const started = Date.now();
    const mapping = await proposeMapping(file, await loadRegistry());
    return Response.json({ profile: profile(file), mapping, seconds: Math.round((Date.now() - started) / 100) / 10 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
