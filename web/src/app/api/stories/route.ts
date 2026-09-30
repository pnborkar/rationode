import { demoMode } from "@/lib/neo4j";
import { complaintText, SETS, status } from "@/lib/stories";
import { withTenant } from "@/lib/tenant";

// Sets with their load status; loaded sets also carry what the live tab needs.
async function GET_() {
  if (!demoMode()) return Response.json([]);   // the Events-tab sets are the Streamly demo's
  const st = await status();
  return Response.json(SETS.map((s) => {
    const x = st.find((y) => y.set === s.set)!;
    return {
      set: s.set, loaded: x.loaded, outcomesLoaded: x.outcomesLoaded,
      // Revealed only once loaded, so the Events tab can keep sets anonymous.
      story: x.loaded ? { key: s.key, title: s.title, point: s.point, customer: s.customer,
                          message: complaintText(s), via_bank: s.via_bank } : null,
    };
  }));
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
