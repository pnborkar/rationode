// The live pipeline (demo spec §19): events captured by the MCP gateway and the Zendesk webhook, run
// through the TypeScript detector per ticket, written to Neo4j under scenario "live".
import { rowsDict, Detector } from "./detector";
import type { ContractEvent } from "./contract";
import { DEMO_NOW } from "./customer";
import { toContract, type RawEvent } from "./nativeAdapter";
import { query } from "./neo4j";
import { writeRows } from "./storyWriter";
import { loadRegistry } from "./uploads";

export const LIVE = "live";

// Live events sit on the demo's day (DEMO_NOW's date) at the current time of day, in the story's timeline.
export function demoClock(): string {
  const now = new Date();
  const d = new Date(DEMO_NOW);
  d.setUTCHours(now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function newId(prefix: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return `${prefix}_${Array.from({ length: 14 }, () => chars[Math.floor(Math.random() * chars.length)]).join("")}`;
}

// A live decision is about the customer and charge that already exist (same source key), not a copy.
async function resolveEntities(rows: Record<string, Record<string, unknown>[]>) {
  const keys = rows.entities.map((e) => ({ id: e.entity_id, s: e.source_system, k: e.source_key }));
  if (!keys.length) return;
  const found = await query<{ id: string; existing: string }>(
    `UNWIND $keys AS k
     MATCH (e:Entity {source_system: k.s, source_key: k.k}) WHERE e.scenario_id <> $live
     WITH k, e ORDER BY CASE e.scenario_id WHEN 'history' THEN 0 ELSE 1 END
     RETURN k.id AS id, collect(e.entity_id)[0] AS existing`,
    { keys, live: LIVE },
  );
  const map = new Map(found.map((f) => [f.id, f.existing]));
  const to = (id: unknown) => map.get(id as string) ?? id;
  rows.entities = rows.entities.filter((e) => !map.has(e.entity_id as string));
  rows.about = rows.about.map((r) => ({ ...r, entity_id: to(r.entity_id) }));
  rows.same_as = rows.same_as.map((r) => ({ ...r, from: to(r.from), to: to(r.to) }));
  rows.links = (rows.links ?? []).map((r) => ({ ...r, from: to(r.from), to: to(r.to) }));
}

// Record raw events and re-detect the live scenario (small: a demo's worth of tickets), idempotently.
export async function ingestLive(raws: RawEvent[]) {
  const stored = await query<{ id: string; source: string; type: string; at: string; payload: string }>(
    `MATCH (e:Event {scenario_id: $live})
     RETURN e.event_id AS id, e.source_system AS source, e.event_type AS type, toString(e.occurred_at) AS at,
            e.payload_json AS payload`,
    { live: LIVE },
  );
  const incoming = new Set(raws.map((r) => r.event_id));
  const all: RawEvent[] = [
    ...stored.map((s) => ({ event_id: s.id.slice(LIVE.length + 1), source_system: s.source, event_type: s.type,
                            occurred_at: s.at.replace(/\.\d+Z$/, "Z"), payload: JSON.parse(s.payload) }))
      .filter((r) => !incoming.has(r.event_id)),
    ...raws,
  ];
  const events = all.map(toContract).filter((e): e is ContractEvent => !!e);
  // The gateway knows which calls are one conversation (session): a lookup made while working a ticket
  // belongs to that ticket even if its arguments didn't name it.
  const ticketOfSession = new Map<string, string>();
  for (const e of events) {
    const { session_id, ticket_id } = e.entity_refs;
    if (session_id && ticket_id) ticketOfSession.set(session_id, ticket_id);
  }
  for (const e of events) {
    const { session_id, ticket_id } = e.entity_refs;
    if (session_id && !ticket_id && ticketOfSession.has(session_id)) e.entity_refs.ticket_id = ticketOfSession.get(session_id);
  }
  const rows = rowsDict(new Detector(await loadRegistry(), LIVE).run(events));
  await resolveEntities(rows);
  await writeRows(rows);
  return {
    events: rows.events.length,
    decisions: rows.decisions.map((d) => ({ id: d.decision_id as string, type: d.decision_type as string, stage: d.stage as string })),
    overrides: rows.overrides.length,
  };
}

// Re-running a case replaces that ticket's earlier live events and decisions.
export async function removeLiveTicket(ticketId: string) {
  await query(
    `MATCH (e:Event {scenario_id: $live, ticket_id: $ticket})
     OPTIONAL MATCH (d:Decision {scenario_id: $live})-[:EVIDENCED_BY]->(e)
     OPTIONAL MATCH (d)-[:HAD_CONTEXT]->(c:Context)
     OPTIONAL MATCH (d)-[:LED_TO]->(o:Outcome {scenario_id: $live})
     DETACH DELETE e, d, c, o`,
    { live: LIVE, ticket: ticketId },
  );
  await query(`MATCH (t:Entity {scenario_id: $live, source_key: $key}) DETACH DELETE t`, { live: LIVE, key: `ticket:${ticketId}` });
}

export async function liveSummary() {
  const [r] = await query<{ decisions: number; proposals: number; finals: number; overrides: number; tickets: number }>(
    `OPTIONAL MATCH (d:Decision {scenario_id: $live})
     WITH count(d) AS decisions, sum(CASE d.stage WHEN 'PROPOSAL' THEN 1 ELSE 0 END) AS proposals,
          sum(CASE d.stage WHEN 'FINAL' THEN 1 ELSE 0 END) AS finals
     OPTIONAL MATCH (:Decision {scenario_id: $live})-[o:OVERRIDES]->()
     WITH decisions, proposals, finals, count(o) AS overrides
     OPTIONAL MATCH (e:Event {scenario_id: $live})
     RETURN decisions, proposals, finals, overrides, count(DISTINCT e.ticket_id) AS tickets`,
    { live: LIVE },
  );
  return r;
}
