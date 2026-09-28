// Port of pipeline/src/rationode/analytics/features.py - must encode identically.
import { query } from "./neo4j";

export type Context = Record<string, string | number | boolean | null>;

const TYPE_PREFIX: Record<string, string> = {
  "charge.fraud_screen": "charge.",
  "support.complaint_resolution": "support.",
  "dispute.response": "dispute.",
  "dispute.evidence": "dispute.",
};

type Attr = {
  key: string;
  datatype: string;
  encoding: string;
  values: string[] | null;
  scale_max: number | null;
  display_name: string;
};

let attrsCache: Attr[] | null = null;

export async function attributes(): Promise<Attr[]> {
  if (!attrsCache) {
    attrsCache = await query<Attr>(
      `MATCH (s:SchemaElement {kind: 'ATTRIBUTE', status: 'APPROVED'})
       RETURN s.key AS key, s.datatype AS datatype, s.encoding AS encoding, s.values AS values,
              s.scale_max AS scale_max, s.display_name AS display_name
       ORDER BY key`,
    );
  }
  return attrsCache;
}

export async function encode(decisionType: string, ctx: Context): Promise<number[]> {
  const prefix = TYPE_PREFIX[decisionType];
  const out: number[] = [];
  for (const a of (await attributes()).filter((a) => a.key.startsWith(prefix))) {
    const v = ctx[a.key];
    if (a.datatype === "BOOLEAN") out.push(v ? 1 : 0);
    else if (a.encoding === "NUMERIC") out.push(Math.min(1, Number(v ?? 0) / (a.scale_max || 1)));
    else for (const value of a.values ?? []) out.push(v === value ? 1 : 0);
  }
  return out;
}

const usd = (v: unknown) => `$${Number(v ?? 0).toFixed(0)}`;
const words = (v: unknown) => String(v ?? "").replaceAll("_", " ");

// Context only (no decision), identical to the Python version used for embeddings.
export function contextText(decisionType: string, c: Context): string {
  if (decisionType === "support.complaint_resolution") {
    return (
      `Complaint about ${words(c["support.complaint_category"])} via ${c["support.channel"]}. ` +
      `Customer tenure ${c["support.tenure_months"]} months on ${c["support.plan"]} plan, ` +
      `charge ${usd(c["support.amount_usd"])}, ${c["support.prior_refunds_90d"]} refunds in last 90 days.`
    );
  }
  if (decisionType === "dispute.response" || decisionType === "dispute.evidence") {
    return (
      `Card dispute: ${words(c["dispute.category"])}, amount ${usd(c["dispute.amount_usd"])}, ` +
      `customer tenure ${c["dispute.tenure_months"]} months, ` +
      `${c["dispute.prior_complaint"] ? "complained before disputing" : "no prior complaint"}, ` +
      `usage logs ${c["dispute.usage_logs_available"] ? "available" : "not available"}.`
    );
  }
  return (
    `Charge screening: ${c["charge.is_renewal"] ? "renewal" : "signup"} on ${c["charge.plan"]}, ` +
    `risk score ${c["charge.risk_score"]}, card age ${c["charge.card_age_days"]} days, card country ` +
    `${c["charge.country_match"] ? "matches" : "does not match"}.`
  );
}
