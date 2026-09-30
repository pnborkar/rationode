import { z } from "zod";
import { listTables } from "@/lib/databricks";
import { query, baseScenario } from "@/lib/neo4j";
import { aiStatus, candidateDatabricks, databricksStatus, settingsKeySet, testAi } from "@/lib/settings";
import { listUploads } from "@/lib/uploads";
import { withTenant } from "@/lib/tenant";

export const maxDuration = 120;

// GET: what this deployment is connected to (values masked, never secrets), for the Settings tab.
async function GET_(request: Request) {
  const env = (n: string) => Boolean(process.env[n]?.trim());
  const origin = new URL(request.url).origin;
  return Response.json({
    tenant: baseScenario(),
    neo4j: { configured: env("NEO4J_URI") && env("NEO4J_PASSWORD"), uri: process.env.NEO4J_URI ?? "",
             database: process.env.NEO4J_DATABASE ?? "neo4j" },
    ai: await aiStatus(),
    databricks: await databricksStatus(),
    settingsKey: settingsKeySet(),
    accessCode: env("DEMO_ACCESS_CODE"),
    endpoints: { gateway: `${origin}/api/gateway`, zendesk: `${origin}/api/webhooks/zendesk`, mcp: `${origin}/api/mcp` },
    loads: await listUploads(),
  });
}

const Test = z.object({
  test: z.enum(["neo4j", "anthropic", "databricks"]),
  databricks: z.object({ host: z.string(), warehouse: z.string(), schema: z.string(), token: z.string().optional() }).optional(),
  ai: z.object({ model: z.string(), apiKey: z.string().optional() }).optional(),
});

// POST {test}: a real round trip to one service; Databricks and AI with the form's values (saved or not).
async function POST_(request: Request) {
  const body = Test.safeParse(await request.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
  const started = Date.now();
  try {
    let detail: string;
    if (body.data.test === "neo4j") {
      const [r] = await query<{ n: number }>("MATCH (e:Event) WHERE e.scenario_id = $s RETURN count(e) AS n", { s: baseScenario() });
      detail = `${r.n.toLocaleString()} events in ${baseScenario()}`;
    } else if (body.data.test === "anthropic") {
      detail = await testAi(body.data.ai ?? { model: (await aiStatus()).agentModel });
    } else {
      const cfg = body.data.databricks ? await candidateDatabricks(body.data.databricks) : undefined;
      const tables = await listTables(cfg);
      detail = `${tables.length} tables: ${tables.map((t) => `${t.table} (${t.rows.toLocaleString()})`).join(", ")}`;
    }
    return Response.json({ ok: true, detail, ms: Date.now() - started });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message, ms: Date.now() - started });
  }
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
export const POST = withTenant(POST_);
