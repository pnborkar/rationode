// Databricks connector (demo spec §21): read a schema's tables through the SQL Statement Execution API
// (plain HTTPS, so it runs anywhere the app runs). Each table is handed to "Connect a source" as one
// source (JSON lines of its rows; nested STRUCT/ARRAY/MAP columns are parsed so they flatten like JSONL),
// then mapped, validated and loaded exactly like an uploaded file. The connection comes from Settings
// (saved per tenant) or the environment; Settings' Test passes one that isn't saved yet.
import { databricksSettings, type DatabricksSettings } from "./settings";

type Column = { name: string; type_name: string };
type StatementResponse = {
  statement_id: string;
  status: { state: string; error?: { message?: string } };
  manifest?: { schema: { columns: Column[] }; total_chunk_count?: number };
  result?: { data_array?: (string | null)[][]; next_chunk_internal_link?: string };
};

export const databricksConfig = databricksSettings;

async function config(given?: DatabricksSettings): Promise<DatabricksSettings> {
  const cfg = given ?? await databricksSettings();
  if (!cfg) throw new Error("Databricks is not configured: add the connection in Settings");
  return cfg;
}

async function call<T>(cfg: DatabricksSettings, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${cfg.host}${path}`, {
    ...init, headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Databricks ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

// Run one statement; poll until it finishes, then gather every result chunk.
export async function sql(statement: string, given?: DatabricksSettings): Promise<{ columns: Column[]; rows: (string | null)[][] }> {
  const cfg = await config(given);
  let r = await call<StatementResponse>(cfg, "/api/2.0/sql/statements", {
    method: "POST",
    body: JSON.stringify({ warehouse_id: cfg.warehouse, statement, wait_timeout: "50s", disposition: "INLINE", format: "JSON_ARRAY" }),
  });
  while (r.status.state === "PENDING" || r.status.state === "RUNNING") {
    await new Promise((ok) => setTimeout(ok, 1500));
    r = await call<StatementResponse>(cfg, `/api/2.0/sql/statements/${r.statement_id}`);
  }
  if (r.status.state !== "SUCCEEDED") throw new Error(`Databricks SQL ${r.status.state}: ${r.status.error?.message ?? statement}`);
  const rows = [...(r.result?.data_array ?? [])];
  let next = r.result?.next_chunk_internal_link;
  while (next) {
    const chunk = await call<{ data_array?: (string | null)[][]; next_chunk_internal_link?: string }>(cfg, next);
    rows.push(...(chunk.data_array ?? []));
    next = chunk.next_chunk_internal_link;
  }
  return { columns: r.manifest?.schema.columns ?? [], rows };
}

const quoted = (fq: string) => fq.split(".").map((p) => `\`${p.replaceAll("`", "")}\``).join(".");

export async function listTables(given?: DatabricksSettings): Promise<{ table: string; rows: number }[]> {
  const cfg = await config(given);
  const { rows } = await sql(`SHOW TABLES IN ${quoted(cfg.schema)}`, cfg);
  const names = rows.map((r) => r[1]!).filter(Boolean).sort();
  return Promise.all(names.map(async (t) => ({
    table: t, rows: Number((await sql(`SELECT count(*) FROM ${quoted(`${cfg.schema}.${t}`)}`, cfg)).rows[0][0]),
  })));
}

// A table's rows as JSON lines, plus its current Delta version (for provenance and incremental reads).
export async function readTable(table: string): Promise<{ name: string; content: string; rows: number; version: number | null }> {
  const cfg = await config();
  const fq = quoted(`${cfg.schema}.${table}`);
  const { columns, rows } = await sql(`SELECT * FROM ${fq}`, cfg);
  const nested = new Set(columns.filter((c) => ["STRUCT", "ARRAY", "MAP"].includes(c.type_name)).map((c) => c.name));
  const lines = rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c, i) => {
    const v = r[i];
    return [c.name, v != null && nested.has(c.name) ? JSON.parse(v) : v];
  }))));
  const history = await sql(`DESCRIBE HISTORY ${fq} LIMIT 1`, cfg).catch(() => null);
  const vIdx = history?.columns.findIndex((c) => c.name === "version") ?? -1;
  const version = history && vIdx >= 0 ? Number(history.rows[0]?.[vIdx]) : null;
  return { name: table, content: lines.join("\n") + "\n", rows: rows.length, version };
}
