// Rationode's decision graph as an MCP server, so any agent can ask the graph before acting.
// Stateless Streamable HTTP: a fresh server and transport per request (works on serverless).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Context } from "@/lib/features";
import { findPrecedent } from "@/lib/findPrecedent";
import { checkFraudPatterns } from "@/lib/fraud";
import { checkBeforeAct } from "@/lib/precedent";
import { why } from "@/lib/why";

// Decision types are data (any domain, §23.8): Streamly's are e.g. support.complaint_resolution, dispute.response,
// dispute.evidence; a loaded domain adds its own (e.g. loan.offer). Unknown types simply find no precedent.

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function server() {
  const mcp = new McpServer({ name: "rationode", version: "0.1.0" });

  mcp.registerTool("check_before_act", {
    title: "Check before acting",
    description:
      "Before making a decision, see what happened in similar past decisions: options chosen, their dispute, " +
      "churn, win, and cost outcomes (and, for any domain, the rate of each outcome type and of good / bad outcomes), " +
      "plus a what-if through the learned outcome tree where one exists. Context uses namespaced attributes, e.g. " +
      "support.tenure_months, dispute.category; a loaded domain's use its own prefix (e.g. loan.requested_amount).",
    inputSchema: {
      decision_type: z.string().min(1),
      context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      customer_email: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ decision_type, context, customer_email }) =>
    asText(await checkBeforeAct(decision_type, context as Context, 150, customer_email)));

  mcp.registerTool("find_precedent", {
    title: "Find precedent",
    description: "Free-text search over past decisions' contexts (e.g. 'annual plan didn't use renewal').",
    inputSchema: {
      query: z.string(),
      decision_type: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, decision_type, limit }) => asText(await findPrecedent(query, decision_type, limit)));

  mcp.registerTool("check_fraud_patterns", {
    title: "Check fraud patterns",
    description: "The identity behind a customer's charge: card and device, other accounts sharing them and how their " +
      "charges ended (unauthorized-charge disputes, fraud declines), the connected cluster, and the fraud tool's decision. " +
      "Facts, not a verdict.",
    inputSchema: { customer_email: z.string(), charge_id: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ customer_email, charge_id }) => {
    const r = await checkFraudPatterns(customer_email, charge_id);
    return r ? asText(r) : { ...asText({ error: "No such customer" }), isError: true };
  });

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
