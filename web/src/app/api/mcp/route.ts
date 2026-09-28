// Rationode's decision graph as an MCP server, so any agent can ask the graph before acting.
// Stateless Streamable HTTP: a fresh server and transport per request (works on serverless).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Context } from "@/lib/features";
import { findPrecedent } from "@/lib/findPrecedent";
import { checkBeforeAct } from "@/lib/precedent";
import { why } from "@/lib/why";

const DECISION_TYPES = ["support.complaint_resolution", "dispute.response", "dispute.evidence"] as const;

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function server() {
  const mcp = new McpServer({ name: "rationode", version: "0.1.0" });

  mcp.registerTool("check_before_act", {
    title: "Check before acting",
    description:
      "Before making a decision, see what happened in similar past decisions: options chosen, their dispute, " +
      "churn, win, and cost outcomes, plus a what-if through the learned outcome tree for each possible action. " +
      "Context uses namespaced attributes, e.g. support.tenure_months, dispute.category.",
    inputSchema: {
      decision_type: z.enum(DECISION_TYPES),
      context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    },
    annotations: { readOnlyHint: true },
  }, async ({ decision_type, context }) => asText(await checkBeforeAct(decision_type, context as Context)));

  mcp.registerTool("find_precedent", {
    title: "Find precedent",
    description: "Free-text search over past decisions' contexts (e.g. 'annual plan didn't use renewal').",
    inputSchema: {
      query: z.string(),
      decision_type: z.enum(DECISION_TYPES).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, decision_type, limit }) => asText(await findPrecedent(query, decision_type, limit)));

  mcp.registerTool("why", {
    title: "Why",
    description: "Explain one past decision: its case chain across systems, outcomes, tree branches, and similar decisions.",
    inputSchema: { decision_id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ decision_id }) => {
    const result = await why(decision_id);
    return result ? asText(result) : { ...asText({ error: "No such decision" }), isError: true };
  });

  return mcp;
}

async function handle(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server().connect(transport);
  return transport.handleRequest(request);
}

export { handle as GET, handle as POST, handle as DELETE };
