import { IS_DEMO, SCENARIO } from "@/lib/neo4j";

// Which tenant this app serves (demo spec §21): the Streamly demo ("history") or another tenant.
export function GET() {
  return Response.json({ tenant: SCENARIO, demo: IS_DEMO });
}
