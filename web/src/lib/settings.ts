// Settings (demo spec §22): a tenant's connections, entered in the app instead of .env. The non-secret values
// sit on a TenantConfig node in Neo4j (one per tenant); a token is encrypted (AES-256-GCM) with SETTINGS_KEY
// from the deployment's environment and is never sent back to the browser. Infrastructure secrets (Neo4j,
// Anthropic, the access code) stay in the environment and are only reported as set or not.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { query, SCENARIO } from "./neo4j";

export type DatabricksSettings = { host: string; warehouse: string; schema: string; token: string };

// Workspace hosts only: the server sends the token to this host, so it must not be any URL.
const DATABRICKS_HOST = /^https:\/\/[a-z0-9.-]+\.(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)$/;
const SCHEMA = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;
const WAREHOUSE = /^[A-Za-z0-9]+$/;

function key(): Buffer | null {
  const k = process.env.SETTINGS_KEY?.trim();
  return k ? createHash("sha256").update(k).digest() : null;
}

function encrypt(text: string): string {
  const k = key();
  if (!k) throw new Error("SETTINGS_KEY is not set in the environment, so tokens can't be stored");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(stored: string): string | null {
  const k = key();
  if (!k) return null;
  try {
    const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64"));
    const d = createDecipheriv("aes-256-gcm", k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    return null;   // SETTINGS_KEY changed since the token was saved
  }
}

export function checkDatabricks(v: { host: string; warehouse: string; schema: string }) {
  const host = v.host.trim().replace(/\/+$/, "");
  if (!DATABRICKS_HOST.test(host)) throw new Error("Host must be a Databricks workspace URL, e.g. https://dbc-xxxx.cloud.databricks.com");
  if (!WAREHOUSE.test(v.warehouse.trim())) throw new Error("Warehouse ID is letters and digits, e.g. 575f6f3500cf78e4");
  if (!SCHEMA.test(v.schema.trim())) throw new Error("Schema is catalog.schema, e.g. workspace.rationode_test");
  return { host, warehouse: v.warehouse.trim(), schema: v.schema.trim() };
}

type Saved = { host: string; warehouse: string; schema: string; token_enc: string | null; updated_at: string };

async function saved(): Promise<Saved | null> {
  const [r] = await query<Saved>(
    `MATCH (t:TenantConfig {tenant: $tenant, kind: 'databricks'})
     RETURN t.host AS host, t.warehouse AS warehouse, t.schema AS schema, t.token_enc AS token_enc,
            toString(t.updated_at) AS updated_at`, { tenant: SCENARIO });
  return r ?? null;
}

// The connection in use: saved in Settings first, else the environment (DATABRICKS_*).
export async function databricksSettings(): Promise<(DatabricksSettings & { source: "settings" | "env" }) | null> {
  const s = await saved();
  if (s) {
    const token = s.token_enc ? decrypt(s.token_enc) : null;
    return token ? { host: s.host, warehouse: s.warehouse, schema: s.schema, token, source: "settings" } : null;
  }
  const e = process.env;
  const host = e.DATABRICKS_HOST?.replace(/\/$/, "");
  return host && e.DATABRICKS_TOKEN && e.DATABRICKS_WAREHOUSE_ID && e.DATABRICKS_SCHEMA
    ? { host, token: e.DATABRICKS_TOKEN, warehouse: e.DATABRICKS_WAREHOUSE_ID, schema: e.DATABRICKS_SCHEMA, source: "env" }
    : null;
}

// What the Settings tab may see: values without the token, and whether the saved token can be read.
export async function databricksStatus() {
  const s = await saved();
  if (s) {
    return { source: "settings" as const, host: s.host, warehouse: s.warehouse, schema: s.schema, updated_at: s.updated_at,
             token: s.token_enc ? (decrypt(s.token_enc) ? "set" : "unreadable (SETTINGS_KEY changed): enter it again") : "missing" };
  }
  const cfg = await databricksSettings();
  return cfg ? { source: "env" as const, host: cfg.host, warehouse: cfg.warehouse, schema: cfg.schema, token: "set" }
    : { source: null, token: "missing" };
}

// Save the connection; a blank token keeps the one already saved, for the same host only (a saved token
// is never sent to a different workspace).
export async function saveDatabricks(v: { host: string; warehouse: string; schema: string; token?: string }) {
  const c = checkDatabricks(v);
  const token = v.token?.trim();
  const prev = await saved();
  const tokenEnc = token ? encrypt(token) : prev?.host === c.host ? prev.token_enc : null;
  if (!tokenEnc) throw new Error("Enter the access token");
  await query(
    `MERGE (t:TenantConfig {tenant: $tenant, kind: 'databricks'})
     SET t.host = $host, t.warehouse = $warehouse, t.schema = $schema, t.token_enc = $tokenEnc, t.updated_at = datetime()`,
    { tenant: SCENARIO, ...c, tokenEnc });
}

export async function clearDatabricks() {
  await query(`MATCH (t:TenantConfig {tenant: $tenant, kind: 'databricks'}) DELETE t`, { tenant: SCENARIO });
}

// A token entered in the form but not saved yet, for "Test" before "Save".
export async function candidateDatabricks(v: { host: string; warehouse: string; schema: string; token?: string }): Promise<DatabricksSettings> {
  const c = checkDatabricks(v);
  const current = await databricksSettings();
  const token = v.token?.trim() || (current?.host === c.host ? current.token : undefined);
  if (!token) throw new Error("Enter the access token");
  return { ...c, token };
}

export const settingsKeySet = () => Boolean(key());

// ------------------------------------------------------------------ AI (models and the tenant's own key)
// Models the agent's request shape works with (adaptive thinking, effort, refusal fallbacks "default").
// Claude Haiku 4.5 is left out: it doesn't take adaptive thinking.
export const AI_MODELS = ["claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"] as const;
const DEFAULT_MODEL = process.env.AGENT_MODEL ?? "claude-opus-5";

type SavedAi = { agent_model: string | null; mapping_model: string | null; key_enc: string | null; updated_at: string };

async function savedAi(): Promise<SavedAi | null> {
  const [r] = await query<SavedAi>(
    `MATCH (t:TenantConfig {tenant: $tenant, kind: 'ai'})
     RETURN t.agent_model AS agent_model, t.mapping_model AS mapping_model, t.key_enc AS key_enc,
            toString(t.updated_at) AS updated_at`, { tenant: SCENARIO });
  return r ?? null;
}

// The models and key in use: saved in Settings first, else the environment (AGENT_MODEL, ANTHROPIC_API_KEY).
export async function aiSettings() {
  const s = await savedAi();
  const key = s?.key_enc ? decrypt(s.key_enc) : null;
  return {
    agentModel: s?.agent_model ?? DEFAULT_MODEL,
    mappingModel: s?.mapping_model ?? DEFAULT_MODEL,
    apiKey: key ?? undefined,   // undefined: the SDK reads ANTHROPIC_API_KEY
    keySource: key ? "settings" as const : process.env.ANTHROPIC_API_KEY?.trim() ? "env" as const : null,
    keyUnreadable: Boolean(s?.key_enc && !key),
    updatedAt: s?.updated_at,
  };
}

export async function anthropicClient() {
  const { apiKey } = await aiSettings();
  return new Anthropic(apiKey ? { apiKey } : undefined);
}

export async function aiStatus() {
  const a = await aiSettings();
  return { agentModel: a.agentModel, mappingModel: a.mappingModel, models: AI_MODELS, keySource: a.keySource,
           keyUnreadable: a.keyUnreadable, updatedAt: a.updatedAt };
}

const Model = (m: string) => {
  if (!(AI_MODELS as readonly string[]).includes(m)) throw new Error(`Model must be one of ${AI_MODELS.join(", ")}`);
  return m;
};

// Save models and, optionally, the tenant's own Anthropic key (blank keeps it; clearKey drops it).
export async function saveAi(v: { agentModel: string; mappingModel: string; apiKey?: string; clearKey?: boolean }) {
  const key = v.apiKey?.trim();
  const keyEnc = v.clearKey ? null : key ? encrypt(key) : (await savedAi())?.key_enc ?? null;
  await query(
    `MERGE (t:TenantConfig {tenant: $tenant, kind: 'ai'})
     SET t.agent_model = $agent, t.mapping_model = $mapping, t.key_enc = $keyEnc, t.updated_at = datetime()`,
    { tenant: SCENARIO, agent: Model(v.agentModel), mapping: Model(v.mappingModel), keyEnc });
}

export async function clearAi() {
  await query(`MATCH (t:TenantConfig {tenant: $tenant, kind: 'ai'}) DELETE t`, { tenant: SCENARIO });
}

// "Test": one small request shaped like the agent's (adaptive thinking, effort), with the form's model and key.
export async function testAi(v: { model: string; apiKey?: string }) {
  const key = v.apiKey?.trim() || (await aiSettings()).apiKey;
  const client = new Anthropic(key ? { apiKey: key } : undefined);
  const r = await client.messages.create({
    model: Model(v.model), max_tokens: 1024, thinking: { type: "adaptive" }, output_config: { effort: "low" },
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
  });
  return `${r.model} answered (${r.stop_reason}) with ${key === undefined ? "the environment's" : v.apiKey?.trim() ? "the entered" : "the saved"} key`;
}

