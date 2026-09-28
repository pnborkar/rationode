import { complaintText, SETS, status } from "@/lib/stories";

// Sets with their load status; loaded sets also carry what the live tab needs.
export async function GET() {
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
