import { demoMode, baseScenario } from "@/lib/neo4j";
import { withTenant } from "@/lib/tenant";

// Which tenant this app serves (demo spec §21): the Streamly demo ("history") or another tenant.
function GET_() {
  return Response.json({ tenant: baseScenario(), demo: demoMode() });
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
