// Event nodes carry either a vendor payload (history and sets: Stripe webhooks, app summaries) or,
// from contract-based loads such as uploads, a canonical type and normalized data (data_json).
// These Cypher fragments read either, so live tools work for both.

// `v` is one of the canonical types (vendor names that differ are listed too).
export function isType(v: string, ...types: string[]): string {
  const names = types.flatMap((t) => (t === "usage.weekly" ? [t, "playback.weekly_summary"] : [t]));
  return `coalesce(${v}.canonical_type, ${v}.event_type) IN [${names.map((t) => `'${t}'`).join(", ")}]`;
}

// A normalized data field, falling back to where the vendor payload keeps it.
export function field(v: string, name: string, vendor: string): string {
  return `coalesce(apoc.convert.fromJsonMap(${v}.data_json).${name}, ${vendor})`;
}

// Stripe amounts are in cents inside data.object; the contract's are in dollars.
export const amount = (v: string) => field(v, "amount", `apoc.convert.fromJsonMap(${v}.payload_json).data.object.amount / 100.0`);
export const payloadField = (v: string, name: string) => field(v, name, `apoc.convert.fromJsonMap(${v}.payload_json).${name}`);
