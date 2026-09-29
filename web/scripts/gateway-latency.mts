// Gateway overhead: the same tool call direct to the tool server vs through Rationode's gateway.
//   npx tsx --env-file=../.env scripts/gateway-latency.mts [base-url]
import { withMcp } from "../src/lib/mcpClient";
const base = process.argv[2] ?? "http://localhost:3100";
const auth = { Authorization: `Bearer ${process.env.DEMO_ACCESS_CODE}` };
const call = (path: string, headers: Record<string, string>) => withMcp(`${base}${path}`, headers, (c) =>
  c.callTool({ name: "propose_resolution", arguments: { ticket_id: "latency-test", option: "voucher", amount_usd: 1, rationale: "latency test" } }));
const time = async (path: string, headers: Record<string, string>) => {
  await call(path, headers);   // warm up
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) { const t = Date.now(); await call(path, headers); ms.push(Date.now() - t); }
  return ms.sort((a, b) => a - b)[2];
};
const direct = await time("/api/streamly/mcp", auth);
const viaGateway = await time("/api/gateway", { ...auth, "x-agent-id": "latency-test", "x-agent-version": "t", "x-agent-session": "sess_latency" });
console.log(`median of 5: direct ${direct} ms · via gateway ${viaGateway} ms · overhead ${viaGateway - direct} ms`);
