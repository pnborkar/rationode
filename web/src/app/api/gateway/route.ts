// Rationode's MCP gateway (demo spec §19). An agent points at this instead of its tool server; every call
// is forwarded unchanged to the upstream (here Streamly's tool server) and recorded as an mcp_gateway
// tool-call event for the live pipeline. Recording runs after the response (fail-open): if it fails, the
// agent's call has already gone through.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { after } from "next/server";
import { demoClock, ingestLive, newId } from "@/lib/live";
import { appAuth, jsonResult, withMcp } from "@/lib/mcpClient";
import { apiPath, withTenant } from "@/lib/tenant";

export const maxDuration = 60;

function server(upstream: string, agent: { id: string; version: string; session: string }) {
  const s = new Server({ name: "rationode-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, () => withMcp(upstream, appAuth(), (c) => c.listTools()));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const at = demoClock();
    const result = await withMcp(upstream, appAuth(), (c) => c.callTool({ name: req.params.name, arguments: req.params.arguments }));
    after(async () => {
      try {
        const callId = newId("call");
        await ingestLive([{
          event_id: callId, source_system: "mcp_gateway", event_type: "tool_call", occurred_at: at,
          payload: { call_id: callId, session_id: agent.session, agent_id: agent.id, agent_version: agent.version,
                     server: "streamly-ops", tool: req.params.name, arguments: req.params.arguments ?? {},
                     result: jsonResult(result) ?? {}, called_at: at },
        }]);
      } catch (err) {
        console.error("gateway: recording failed (call already forwarded)", err);
      }
    });
    return result;
  });
  return s;
}

async function handle(request: Request): Promise<Response> {
  const h = request.headers;
  const upstream = new URL(apiPath("/api/streamly/mcp"), request.url).toString();   // the same workspace's tool server
  const agent = { id: h.get("x-agent-id") ?? "unknown-agent", version: h.get("x-agent-version") ?? "unknown",
                  session: h.get("x-agent-session") ?? newId("sess") };
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server(upstream, agent).connect(transport);
  return transport.handleRequest(request);
}

const handleInTenant = withTenant(handle);
export { handleInTenant as GET, handleInTenant as POST, handleInTenant as DELETE };
