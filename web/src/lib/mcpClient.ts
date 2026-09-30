// A short-lived MCP client over Streamable HTTP (one per call: the servers here are stateless).
import { currentTenant } from "./tenant";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function withMcp<T>(url: string, headers: Record<string, string>, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "rationode", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// Server-to-server calls inside the app pass the access code, as any MCP client would.
// The app calling its own endpoints (the agent's tools through the gateway): the access code, and the workspace of
// the request that made the call (§23.9), so the gateway records into the same workspace.
export const appAuth = () => ({ Authorization: `Bearer ${process.env.DEMO_ACCESS_CODE ?? ""}`, "x-rationode-tenant": currentTenant() });

// The JSON a tool returned as text content (our servers return one JSON text block).
export function jsonResult(result: Record<string, unknown>): unknown {
  const block = (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text");
  if (!block?.text) return null;
  try { return JSON.parse(block.text); } catch { return block.text; }
}
