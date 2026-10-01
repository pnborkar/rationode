// How a decision ended (demo spec §23.11, "a bad outcome decides"): bad if any outcome credited to it is bad for the
// organisation, good if it has good outcomes and no bad one, otherwise not known (no outcome with a polarity). The
// same rule as the tree builder's polarity_label (pipeline/src/rationode/trees/build.py) and the replay reveal, so
// the AI's proposals, Ask and the trees agree.
export type Ended = "good" | "bad" | null;

export const endedOf = (polarities: (string | null | undefined)[]): Ended =>
  polarities.includes("bad") ? "bad" : polarities.includes("good") ? "good" : null;

// Share of decisions that ended good / ended bad (each decision counts once, in one of them at most).
export function endedRates(rows: { polarities: (string | null | undefined)[] }[]) {
  const n = rows.length || 1, ended = rows.map((r) => endedOf(r.polarities));
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { good_rate: r3(ended.filter((e) => e === "good").length / n), bad_rate: r3(ended.filter((e) => e === "bad").length / n) };
}
