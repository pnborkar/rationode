// Feature encoding for generic decision types (demo spec §23.8, phase B). Streamly's attributes (tenure, plan, …)
// are declared in the schema registry; a new domain's aren't. After a load, this derives them from the data itself:
// every context fact of the domain becomes an ATTRIBUTE schema element (numbers scaled by the largest value seen,
// booleans as 0/1, text one-hot over its most frequent values), marked created_by 'mapping'. The existing encoder
// and check_before_act then work unchanged. Then the loaded contexts are re-encoded.
import { contextText, encode, resetAttributes, type Context } from "./features";
import { query } from "./neo4j";

const MAX_VALUES = 20;   // one-hot over at most this many values of a text fact (the most frequent)
const META = new Set(["context_id", "scenario_id", "summary_text", "features", "embedding", "embedding_text", "embedding_model"]);

export async function deriveAttributes(scenario: string, decisionTypes: string[]) {
  const families = [...new Set(decisionTypes.map((t) => t.split(".")[0]))];
  let attributes = 0, encoded = 0;
  for (const family of families) {
    const prefix = `${family}.`;
    const rows = await query<{ ctx: Record<string, unknown> }>(
      `MATCH (d:Decision {scenario_id: $scenario})-[:HAD_CONTEXT]->(c:Context) WHERE d.decision_type STARTS WITH $prefix
       RETURN properties(c) AS ctx`, { scenario, prefix });
    const byKey = new Map<string, unknown[]>();
    for (const { ctx } of rows) {
      for (const [k, v] of Object.entries(ctx)) {
        if (!k.startsWith(prefix) || META.has(k) || v === null || v === undefined || v === "") continue;
        (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(v);
      }
    }
    const specs = [...byKey].map(([key, values]) => {
      const isBool = values.every((v) => typeof v === "boolean");
      const isNum = !isBool && values.every((v) => typeof v === "number");
      const counts = new Map<string, number>();
      if (!isBool && !isNum) for (const v of values) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      return {
        key, datatype: isBool ? "BOOLEAN" : isNum ? "NUMBER" : "STRING", encoding: isNum ? "NUMERIC" : isBool ? "BOOLEAN" : "ONE_HOT",
        scale_max: isNum ? Math.max(...(values as number[]).map((v) => Math.abs(v)), 1) : null,
        values: isNum || isBool ? null : [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_VALUES).map(([v]) => v).sort(),
        display_name: key.slice(prefix.length).replaceAll("_", " "),
      };
    });
    // Streamly's declared attributes are never touched (created_by 'mapping' only).
    await query(
      `UNWIND $specs AS s
       MERGE (e:SchemaElement {key: s.key})
       ON CREATE SET e.kind = 'ATTRIBUTE', e.status = 'APPROVED', e.created_by = 'mapping', e.created_at = datetime(), e.version = 1
       WITH e, s WHERE e.created_by = 'mapping'
       SET e.datatype = s.datatype, e.encoding = s.encoding, e.scale_max = s.scale_max, e.values = s.values,
           e.display_name = s.display_name, e.updated_at = datetime()`, { specs });
    attributes += specs.length;
  }
  resetAttributes();
  // Re-encode the loaded contexts of these decision types with the derived attributes (and their text for search).
  const ctxs = await query<{ id: string; type: string; ctx: Context }>(
    `MATCH (d:Decision {scenario_id: $scenario})-[:HAD_CONTEXT]->(c:Context) WHERE d.decision_type IN $types
     RETURN c.context_id AS id, d.decision_type AS type, properties(c) AS ctx`, { scenario, types: decisionTypes });
  const rows = await Promise.all(ctxs.map(async (c) => ({ id: c.id, features: await encode(c.type, c.ctx), text: contextText(c.type, c.ctx) })));
  for (let i = 0; i < rows.length; i += 2000) {
    await query(`UNWIND $rows AS r MATCH (c:Context {context_id: r.id}) SET c.features = r.features, c.embedding_text = r.text`,
                { rows: rows.slice(i, i + 2000) });
  }
  encoded = rows.length;
  return { attributes, encoded };
}

// Approving a load approves what its mapping introduced (§23.8, phase C): the validation step showed the new decision
// types, options and outcome types before approval, so they become APPROVED in the schema registry (marked approved by
// the mapping approval), and new outcome types are registered with their polarity and a default 90-day window. Trees
// only use approved options and registered outcome types. Streamly's registry entries are not touched.
export async function approveIntroduced(scenario: string, decisionTypes: string[]) {
  await query(
    `UNWIND $types AS t
     MATCH (dt:DecisionType {key: t}) WHERE dt.created_by = 'mapping'
     SET dt.status = 'APPROVED', dt.approved_by = 'mapping approval', dt.approved_at = coalesce(dt.approved_at, datetime())
     WITH t
     MATCH (s:SchemaElement {kind: 'OPTION', decision_type: t}) WHERE s.status = 'PROPOSED' AND s.created_by = 'detector'
     SET s.status = 'APPROVED', s.approved_by = 'mapping approval', s.approved_at = datetime()`, { types: decisionTypes });
  const outcomes = await query<{ type: string; polarity: string | null }>(
    `MATCH (d:Decision {scenario_id: $scenario})-[:LED_TO]->(o:Outcome) WHERE d.decision_type IN $types
     RETURN o.outcome_type AS type, head(collect(o.polarity)) AS polarity`, { scenario, types: decisionTypes });
  await query(
    `UNWIND $rows AS r
     MERGE (s:SchemaElement {key: 'outcome.' + r.type})
     ON CREATE SET s.kind = 'OUTCOME_TYPE', s.status = 'APPROVED', s.created_by = 'mapping', s.created_at = datetime(),
                   s.default_window_days = 90, s.polarity = r.polarity, s.display_name = replace(r.type, '_', ' '), s.version = 1`,
    { rows: outcomes });
  return { outcomeTypes: outcomes.length };
}

