import { z } from "zod";
import { databricksConfig, listTables } from "@/lib/databricks";
import { tablePreview } from "@/lib/sources";

export const maxDuration = 120;

// GET: whether Databricks is configured (?check=1: just that), and the schema's tables with row counts.
export async function GET(request: Request) {
  const cfg = await databricksConfig();
  if (!cfg) return Response.json({ configured: false });
  if (new URL(request.url).searchParams.has("check")) return Response.json({ configured: true, schema: cfg.schema });
  try {
    return Response.json({ configured: true, host: cfg.host, schema: cfg.schema, tables: await listTables() });
  } catch (err) {
    return Response.json({ configured: true, schema: cfg.schema, error: (err as Error).message }, { status: 502 });
  }
}

const Body = z.object({ tables: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).min(1) });

// POST {tables}: for Connect a source, each table's current version, row count and a preview; the rows stay
// on the server (propose, validate and approve read them by reference, §21.2).
export async function POST(request: Request) {
  const body = Body.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  try {
    return Response.json(await Promise.all(body.data.tables.map(tablePreview)));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
