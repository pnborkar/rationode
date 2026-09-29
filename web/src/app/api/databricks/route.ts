import { z } from "zod";
import { databricksConfig, listTables, readTable } from "@/lib/databricks";

export const maxDuration = 120;

// GET: whether Databricks is configured (?check=1: just that), and the schema's tables with row counts.
export async function GET(request: Request) {
  const cfg = databricksConfig();
  if (!cfg) return Response.json({ configured: false });
  if (new URL(request.url).searchParams.has("check")) return Response.json({ configured: true, schema: cfg.schema });
  try {
    return Response.json({ configured: true, host: cfg.host, schema: cfg.schema, tables: await listTables() });
  } catch (err) {
    return Response.json({ configured: true, schema: cfg.schema, error: (err as Error).message }, { status: 502 });
  }
}

const Body = z.object({ tables: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).min(1) });

// POST {tables}: read them (rows as JSON lines) for Connect a source.
export async function POST(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    return Response.json(await Promise.all(body.data.tables.map(readTable)));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
