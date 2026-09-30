import { currentTenant } from "./tenant";
import neo4j, { type Driver, isInt, isDateTime, isDate } from "neo4j-driver";

// One driver per server process (reused across requests and hot reloads).
const globalForNeo4j = globalThis as unknown as { neo4jDriver?: Driver };

export function driver(): Driver {
  if (!globalForNeo4j.neo4jDriver) {
    globalForNeo4j.neo4jDriver = neo4j.driver(
      process.env.NEO4J_URI!,
      neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!),
    );
  }
  return globalForNeo4j.neo4jDriver;
}

// Convert Neo4j values (Integer, DateTime, nodes' property maps) into plain JSON.
function plain(value: unknown): unknown {
  if (isInt(value)) return value.toNumber();
  if (isDateTime(value) || isDate(value)) return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

export async function query<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const result = await driver().executeQuery(cypher, params, {
    database: process.env.NEO4J_DATABASE ?? "neo4j",
  });
  return result.records.map((r) => plain(r.toObject()) as T);
}

// The tenant this app serves (demo spec §21): its base scenario. "history" is the Streamly demo; another
// tenant (e.g. "dbx", loaded from Databricks) sees only its own data, trees and precedent.
// Per request (§23.9): the workspace the request runs in (lib/tenant.ts), not a startup constant.
export const baseScenario = () => currentTenant();
export const demoMode = () => baseScenario() === "history";   // the demo's sets and prepared live customers are Streamly-only
// A tenant's IDs carry its prefix (as the pipeline writes them), e.g. its trees: "dbx|tree:…".
export const tenantId = (id: string) => (demoMode() ? id : `${baseScenario()}|${id}`);
export const fraudPolicyTree = () => tenantId("tree:charge.fraud_screen:policy:policy");
