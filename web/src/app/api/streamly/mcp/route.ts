// Streamly's own tool server (demo spec §19): stands in for the customer's tools behind the gateway.
// Stateless Streamable HTTP, like /api/mcp.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { checkUsage, getCustomer } from "@/lib/customer";
import { withTenant } from "@/lib/tenant";

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const OPTIONS = ["full_refund", "partial_refund", "voucher", "deny", "pause_subscription"] as const;
const CATEGORIES = ["too_expensive", "didnt_use", "billing_error", "content_issue", "not_recognized"] as const;

function server() {
  const mcp = new McpServer({ name: "streamly-ops", version: "0.1.0" });
  mcp.registerTool("get_customer", {
    description: "Look up a customer by email: tenure in months, plan, latest charge, the refunds issued in the last " +
      "90 days (date, amount, charge), and how much of the latest charge has already been refunded.",
    inputSchema: { email: z.string() },
  }, async ({ email }) => {
    const c = await getCustomer(email);
    return c ? asText(c) : { ...asText({ error: "No customer with that email" }), isError: true };
  });
  mcp.registerTool("check_usage_patterns", {
    description: "Check the customer's viewing in the Streamly app: weekly hours for recent weeks, hours since " +
      "their latest charge, last week watched, and the trend. Use it when a complaint or claim depends on " +
      "whether the customer used the service.",
    inputSchema: { email: z.string() },
  }, async ({ email }) => {
    const u = await checkUsage(email);
    return u ? asText(u) : { ...asText({ error: "No customer with that email" }), isError: true };
  });
  mcp.registerTool("propose_resolution", {
    description: "Propose a resolution for the ticket and tag the ticket with the complaint category. " +
      "A human support rep reviews it before anything happens.",
    inputSchema: {
      ticket_id: z.string(), option: z.enum(OPTIONS), amount_usd: z.number(), rationale: z.string(),
      category: z.enum(CATEGORIES).optional(),
    },
  }, async () => asText({ status: "pending_review" }));
  return mcp;
}

async function handle(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server().connect(transport);
  return transport.handleRequest(request);
}

const handleInTenant = withTenant(handle);
export { handleInTenant as GET, handleInTenant as POST, handleInTenant as DELETE };
