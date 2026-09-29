"use client";
// Settings (demo spec §22): what this deployment is connected to, a test for each connection, the endpoints a
// customer points their agent and Zendesk at, and the tenant's Databricks connection (saved in Neo4j, token
// encrypted). Secrets are never shown: only whether they're set.
import { useEffect, useState } from "react";
import DeleteScenario from "./DeleteScenario";

type Status = {
  tenant: string;
  neo4j: { configured: boolean; uri: string; database: string };
  ai: { agentModel: string; mappingModel: string; models: string[]; keySource: "settings" | "env" | null; keyUnreadable: boolean; updatedAt?: string };
  databricks: { source: "settings" | "env" | null; host?: string; warehouse?: string; schema?: string; token: string; updated_at?: string };
  settingsKey: boolean;
  accessCode: boolean;
  endpoints: { gateway: string; zendesk: string; mcp: string };
  loads: { scenario: string; events: number; decisions: number; customers: number }[];
};
type TestResult = { ok: boolean; detail?: string; error?: string; ms: number };

function Dot({ on }: { on: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${on ? "bg-emerald-500" : "bg-zinc-600"}`} />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <h2 className="rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">{title}</h2>
      <div className="space-y-3 p-4 text-sm">{children}</div>
    </section>
  );
}

function Result({ r }: { r?: TestResult | "running" }) {
  if (!r) return null;
  if (r === "running") return <p className="text-xs text-zinc-500">Testing…</p>;
  return <p className={`text-xs ${r.ok ? "text-emerald-400" : "text-red-400"}`}>{r.ok ? `✓ ${r.detail}` : `✕ ${r.error}`} · {r.ms} ms</p>;
}

const button = "rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40";
const input = "w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm";

export default function SettingsTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({});
  const [form, setForm] = useState({ host: "", warehouse: "", schema: "", token: "" });
  const [ai, setAi] = useState({ agentModel: "", mappingModel: "", apiKey: "" });
  const [aiError, setAiError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);


  const apply = (s: Status) => {
    setStatus(s);
    setForm({ host: s.databricks.host ?? "", warehouse: s.databricks.warehouse ?? "", schema: s.databricks.schema ?? "", token: "" });
    setAi({ agentModel: s.ai.agentModel, mappingModel: s.ai.mappingModel, apiKey: "" });
  };
  const load = async () => apply(await (await fetch("/api/settings")).json());
  // Mounted when the tab opens, so it reads fresh status each time.
  useEffect(() => { fetch("/api/settings").then((r) => r.json()).then(apply); }, []);

  async function test(name: "neo4j" | "anthropic" | "databricks", withForm = false) {
    setTests((t) => ({ ...t, [name]: "running" }));
    const given = !withForm ? {} : name === "databricks" ? { databricks: form } : { ai: { model: ai.agentModel, apiKey: ai.apiKey } };
    const res = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" },
                                               body: JSON.stringify({ test: name, ...given }) });
    const r: TestResult = await res.json().catch(() => ({ ok: false, error: res.statusText, ms: 0 }));
    setTests((t) => ({ ...t, [name]: r }));
  }

  async function save() {
    setSaving(true); setError(null);
    const res = await fetch("/api/settings/databricks", { method: "PUT", headers: { "content-type": "application/json" },
                                                          body: JSON.stringify(form) });
    const data = await res.json();
    if (res.ok) await load(); else setError(data.error ?? res.statusText);
    setSaving(false);
  }

  async function saveAiSettings(body: Record<string, unknown>, method = "PUT") {
    setSaving(true); setAiError(null);
    const res = await fetch("/api/settings/ai", { method, headers: { "content-type": "application/json" },
                                                  body: method === "PUT" ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (res.ok) await load(); else setAiError(data.error ?? res.statusText);
    setSaving(false);
  }

  async function forget() {
    if (!window.confirm("Forget the saved Databricks connection? The environment's DATABRICKS_* settings, if any, apply again.")) return;
    await fetch("/api/settings/databricks", { method: "DELETE" });
    await load();
  }

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  if (!status) return <p className="p-4 text-sm text-zinc-500">Loading settings…</p>;
  const d = status.databricks;
  const dbxOn = d.source !== null && d.token === "set";
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto">
      <div className="space-y-3">
        <Section title={`Connections · tenant ${status.tenant}`}>
          <div className="flex items-start justify-between gap-3">
            <div><p className="flex items-center gap-2 font-medium"><Dot on={status.neo4j.configured} /> Neo4j</p>
              <p className="text-xs text-zinc-500">{status.neo4j.uri} · database {status.neo4j.database}</p></div>
            <button className={button} onClick={() => test("neo4j")}>Test</button>
          </div>
          <Result r={tests.neo4j} />
          <div className="flex items-start justify-between gap-3">
            <div><p className="flex items-center gap-2 font-medium"><Dot on={status.ai.keySource !== null} /> Claude (Anthropic)</p>
              <p className="text-xs text-zinc-500">agent {status.ai.agentModel} · mapping {status.ai.mappingModel} · key {
                status.ai.keySource === "settings" ? "from Settings" : status.ai.keySource === "env" ? "from .env" : "missing"}</p></div>
            <button className={button} onClick={() => test("anthropic")}>Test</button>
          </div>
          <Result r={tests.anthropic} />
          <div className="flex items-start justify-between gap-3">
            <div><p className="flex items-center gap-2 font-medium"><Dot on={dbxOn} /> Databricks</p>
              <p className="text-xs text-zinc-500">{d.source ? `${d.host} · warehouse ${d.warehouse} · ${d.schema} · token ${d.token} · from ${d.source === "settings" ? "Settings" : ".env"}` : "not configured"}</p></div>
            <button className={button} onClick={() => test("databricks")} disabled={!dbxOn}>Test</button>
          </div>
          <Result r={tests.databricks} />
          <div className="flex items-center gap-2 text-zinc-500"><Dot on={false} /> Snowflake, BigQuery: not available yet</div>
          <p className="text-xs text-zinc-500">
            Neo4j and the access code ({status.accessCode ? "set" : "not set"}) are set in the deployment&apos;s environment, not here:
            settings are stored in Neo4j, so the app needs Neo4j before it can read them.</p>
        </Section>

        <Section title="Endpoints for your systems">
          {([["MCP gateway (your agent's tool server URL)", status.endpoints.gateway],
             ["Zendesk webhook", status.endpoints.zendesk],
             ["Rationode MCP server (check_before_act, find_precedent…)", status.endpoints.mcp]] as const).map(([label, url]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <div><p className="text-xs text-zinc-400">{label}</p><p className="font-mono text-xs">{url}</p></div>
              <button className={button} onClick={() => copy(label, url)}>{copied === label ? "Copied" : "Copy"}</button>
            </div>
          ))}
        </Section>

        <Section title="Loaded data">
          {status.loads.length === 0 ? <p className="text-zinc-500">Nothing loaded yet (Events tab → Connect a source).</p>
            : status.loads.map((l) => (
              <p key={l.scenario}><span className="font-medium">{l.scenario}</span>
                <span className="text-zinc-500"> · {l.events.toLocaleString()} events · {l.decisions.toLocaleString()} decisions · {l.customers.toLocaleString()} customers</span></p>
            ))}
          <DeleteScenario onDeleted={load} />
        </Section>
      </div>

      <div className="space-y-3">
        <Section title="Databricks connection">
          <p className="text-xs text-zinc-500">
            Rationode reads the schema&apos;s tables through a SQL warehouse (Connect a source → Load tables from Databricks).
            Use a token that can only read this schema, ideally a service principal&apos;s.</p>
          {!status.settingsKey && (
            <p className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
              SETTINGS_KEY isn&apos;t set in the environment, so a token can&apos;t be saved here (it would have to be stored in plain text).</p>
          )}
          <label className="block text-xs text-zinc-400">Workspace URL
            <input className={input} value={form.host} placeholder="https://dbc-xxxx.cloud.databricks.com"
                   onChange={(e) => setForm({ ...form, host: e.target.value })} /></label>
          <label className="block text-xs text-zinc-400">SQL warehouse ID
            <input className={input} value={form.warehouse} placeholder="575f6f3500cf78e4"
                   onChange={(e) => setForm({ ...form, warehouse: e.target.value })} /></label>
          <label className="block text-xs text-zinc-400">Schema (catalog.schema)
            <input className={input} value={form.schema} placeholder="workspace.rationode_test"
                   onChange={(e) => setForm({ ...form, schema: e.target.value })} /></label>
          <label className="block text-xs text-zinc-400">Access token
            <input className={input} type="password" autoComplete="off" value={form.token}
                   placeholder={d.source === "settings" && d.token === "set" ? "saved · leave blank to keep it" : "dapi…"}
                   onChange={(e) => setForm({ ...form, token: e.target.value })} /></label>
          <div className="flex gap-2">
            <button className={button} onClick={() => test("databricks", true)}>Test these settings</button>
            <button className="rounded bg-violet-600 px-3 py-0.5 text-xs font-semibold text-white disabled:opacity-40"
                    onClick={save} disabled={saving || !status.settingsKey}>{saving ? "Saving…" : "Save"}</button>
            {d.source === "settings" && <button className={button} onClick={forget}>Forget saved connection</button>}
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          {d.source === "settings" && d.updated_at && <p className="text-xs text-zinc-500">Saved {d.updated_at.slice(0, 16).replace("T", " ")} UTC.</p>}
          {d.source === "env" && <p className="text-xs text-zinc-500">Currently from .env (DATABRICKS_*). Saving here takes precedence.</p>}
        </Section>

        <Section title="AI (Claude)">
          <p className="text-xs text-zinc-500">
            The support agent answers tickets; the mapping agent proposes how uploaded files and tables map to events.
            A key entered here is this tenant&apos;s own (usage billed to it); leave it empty to use the deployment&apos;s key.</p>
          <label className="block text-xs text-zinc-400">Support agent model
            <select className={input} value={ai.agentModel} onChange={(e) => setAi({ ...ai, agentModel: e.target.value })}>
              {status.ai.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select></label>
          <label className="block text-xs text-zinc-400">Mapping agent model
            <select className={input} value={ai.mappingModel} onChange={(e) => setAi({ ...ai, mappingModel: e.target.value })}>
              {status.ai.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select></label>
          <label className="block text-xs text-zinc-400">Anthropic API key (optional)
            <input className={input} type="password" autoComplete="off" value={ai.apiKey}
                   placeholder={status.ai.keySource === "settings" ? "saved · leave blank to keep it" : "sk-ant-… (empty: use the deployment's key)"}
                   onChange={(e) => setAi({ ...ai, apiKey: e.target.value })} /></label>
          {status.ai.keyUnreadable && <p className="text-xs text-amber-300">The saved key can&apos;t be read (SETTINGS_KEY changed): enter it again.</p>}
          <div className="flex flex-wrap gap-2">
            <button className={button} onClick={() => test("anthropic", true)}>Test support agent model</button>
            <button className="rounded bg-violet-600 px-3 py-0.5 text-xs font-semibold text-white disabled:opacity-40"
                    onClick={() => saveAiSettings(ai)} disabled={saving || (!!ai.apiKey.trim() && !status.settingsKey)}>{saving ? "Saving…" : "Save"}</button>
            {status.ai.keySource === "settings" && (
              <button className={button} onClick={() => saveAiSettings({ ...ai, apiKey: "", clearKey: true })}>Use the deployment&apos;s key</button>)}
            {status.ai.updatedAt && <button className={button} onClick={() => saveAiSettings({}, "DELETE")}>Reset to environment</button>}
          </div>
          <Result r={tests.anthropic} />
          {aiError && <p className="text-xs text-red-400">{aiError}</p>}
          {status.ai.updatedAt && <p className="text-xs text-zinc-500">Saved {status.ai.updatedAt.slice(0, 16).replace("T", " ")} UTC.</p>}
        </Section>
      </div>
    </div>
  );
}
