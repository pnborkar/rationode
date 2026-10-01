"use client";

// "Connect a source" (demo spec §16.2): upload exports, Claude proposes a mapping per file, you see
// and adjust the mapping, the validator checks it and dry-runs the detector, then you approve and
// it is written to Neo4j: in the demo under upload:<name>; in a workspace as a named source (§23.9).
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { DATA_FIELDS } from "@/lib/contract";
import { mapFile, matches, parseFile, TRANSFORMS, type FieldMap, type FileMapping, type ParsedFile, type RecordMap } from "@/lib/mapping";
import { applyFix, CHOICES, modeOf, newField, targetsFor, withMode, type SourceMode } from "@/lib/mappingEdits";
import type { Check, CheckFix, Validation } from "@/lib/validator";
import type { ViewNode, ViewRel } from "./GraphView";
import { WORKSPACE } from "@/lib/workspace";

const GraphView = dynamic(() => import("./GraphView"), { ssr: false });

const SAMPLE_DIR = "/samples/streamly-spring";
const TENANT = WORKSPACE;   // the page's workspace (§23.9)
const DEMO = TENANT === "history";
const SAMPLE_FILES = ["zendesk_ticket_events.csv", "stripe_activity.csv", "support_agent_tool_calls.jsonl",
                      "fraudguard_screening.csv", "subscriptions.csv", "app_usage_weekly.csv"];

// A source: an uploaded file (with its contents) or a Databricks table (a reference: the server reads it,
// the browser only gets a preview, demo spec §21.2).
type Src = { name: string; content?: string; table?: { version: number; rows: number; preview: ParsedFile } };
type Range = { table: string; from: number; to: number };
type ChangeCount = Range & { inserted: number; updated: number; deleted: number };
type Proposal = { status: "mapping" | "done" | "error"; mapping?: FileMapping; seconds?: number; error?: string; edited?: boolean };
type Stats = { support: number; dispute_rate: number | null; churn_rate: number | null; win_rate: number | null };
type RunResult = { ok: boolean; error?: string; scenario: string; source?: string; counts: Record<string, number>;
                   analysis?: { stale: boolean; noTrees: boolean } | null;
                   customers: { email: string; name: string | null }[];
                   subjects?: { id: string; label: string; key: string }[];   // any domain (§23.8): top-level subjects loaded
                   branches: { point_id: string; tree: string; branch: string; before: Stats; after: Stats }[] };
type ReportView = Omit<Validation, "events">;

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function targetClass(t: string): string {
  if (t.startsWith("refs.")) return "text-violet-300";
  if (t.startsWith("data.")) return "text-emerald-300";
  if (t.startsWith("actor.")) return "text-sky-300";
  return "text-zinc-200";
}

function CheckLine({ c, onFix }: { c: Check; onFix?: (fix: CheckFix) => void }) {
  const icon = c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✕";
  const cls = c.level === "ok" ? "text-emerald-400" : c.level === "warn" ? "text-amber-400" : "text-red-400";
  return (
    <li className="flex gap-2 text-xs">
      <span className={`w-3 font-bold ${cls}`}>{icon}</span>
      <span className="text-zinc-300">{c.message}
        {c.examples?.length ? <span className="text-zinc-500"> · {c.examples.join(", ")}</span> : null}
        {c.fix && onFix && <button onClick={() => onFix(c.fix!)} className="ml-2 rounded bg-sky-700 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-sky-600">
          Link to {c.fix.system}&apos;s {c.fix.type}s</button>}</span>
    </li>
  );
}

export default function ConnectSource({ active, onClose, onChanged }: { active: boolean; onClose: () => void; onChanged: () => void }) {
  // The demo names a batch; a workspace names the source (the same name updates it, a new name adds one).
  const [name, setName] = useState(DEMO ? "streamly-spring" : "");
  const [known, setKnown] = useState<string[]>([]);   // the workspace's sources, offered in the name field
  const refreshKnown = () => { if (!DEMO) fetch("/api/upload").then((r) => r.json())
    .then((l: { source?: string }[]) => setKnown(l.map((x) => x.source).filter((x): x is string => !!x))).catch(() => {}); };
  useEffect(refreshKnown, []);
  const [files, setFiles] = useState<Src[]>([]);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [view, setView] = useState<string>("");            // a file name, "validate", or "result"
  const [report, setReport] = useState<ReportView | null>(null);
  // Outcome type -> window (days) the reviewer set (§23.11): used by Validate and saved with the load.
  const [windows, setWindows] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [graph, setGraph] = useState<{ email: string; nodes: ViewNode[]; rels: ViewRel[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dbx, setDbx] = useState<{ configured: boolean; schema?: string } | null>(null);
  // The last Databricks load and the tables changed since (for "Load changes"); set while checking changes.
  const [pending, setPending] = useState<{ batch: string | null; ranges?: Range[] } | null>(null);   // the first load with changes
  const [incremental, setIncremental] = useState<{ ranges: Range[]; changes: ChangeCount[] } | null>(null);
  const refreshPending = () => fetch("/api/databricks/changes").then((r) => r.json()).then(setPending).catch(() => setPending(null));
  useEffect(() => {
    fetch("/api/databricks?check=1").then((r) => r.json()).then((d) => {
      setDbx(d);
      if (d.configured) fetch("/api/databricks/changes").then((r) => r.json()).then(setPending).catch(() => {});
    }).catch(() => setDbx({ configured: false }));
  }, []);

  const parsed = useMemo(() => {
    const out: Record<string, ParsedFile | string> = {};
    for (const f of files) {
      if (f.table) { out[f.name] = f.table.preview; continue; }
      if (f.content === undefined) continue;
      try { out[f.name] = parseFile(f.name, f.content); } catch (e) { out[f.name] = (e as Error).message; }
    }
    return out;
  }, [files]);

  const mappings = files.map((f) => proposals[f.name]?.mapping).filter((m): m is FileMapping => !!m);
  const allMapped = files.length > 0 && mappings.length === files.length;
  const mapping = view && proposals[view]?.mapping;
  const pf = parsed[view];

  const rowCount = (f: Src) => f.table?.rows ?? (typeof parsed[f.name] === "object" ? (parsed[f.name] as ParsedFile).rows.length : 0);
  // What validate and approve send: uploaded files with contents, tables by reference at the version read.
  const sources = () => ({
    files: files.filter((f) => !f.table).map((f) => ({ name: f.name, content: f.content ?? "" })),
    tables: files.filter((f) => f.table).map((f) => ({ table: f.name, version: f.table!.version })),
  });

  function reset(next: Src[]) {
    setFiles(next); setProposals({}); setReport(null); setResult(null); setGraph(null); setError(null); setIncremental(null); setWindows({});
    setView(next[0]?.name ?? "");
  }

  async function useSamples() {
    setBusy("files");
    const next = await Promise.all(SAMPLE_FILES.map(async (n) => ({ name: n, content: await (await fetch(`${SAMPLE_DIR}/${n}`)).text() })));
    setName("streamly-spring");
    reset(next);
    setBusy(null);
  }

  // Databricks: every table in the configured schema, each one source. The server pins each table's current
  // Delta version and sends a preview; propose, validate and approve read that version server-side.
  async function useDatabricks() {
    setBusy("files"); setError(null);
    try {
      const listing = await (await fetch("/api/databricks")).json();
      if (listing.error) throw new Error(listing.error);
      const tables = (listing.tables as { table: string }[]).map((t) => t.table);
      const res = await fetch("/api/databricks", { method: "POST", headers: { "content-type": "application/json" },
                                                   body: JSON.stringify({ tables }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setName(DEMO ? "databricks" : name.trim() || "databricks");
      reset((data as { name: string; version: number; rows: number; preview: ParsedFile }[])
        .map((t) => ({ name: t.name, table: { version: t.version, rows: t.rows, preview: t.preview } })));
    } catch (e) {
      setError(`Databricks: ${(e as Error).message}`);
    }
    setBusy(null);
  }

  async function pickFiles(list: FileList | null) {
    if (!list?.length) return;
    const next = await Promise.all([...list].map(async (f) => ({ name: f.name, content: await f.text() })));
    reset(next);
  }

  async function proposeAll() {
    setBusy("propose"); setReport(null); setResult(null); setError(null);
    setProposals(Object.fromEntries(files.map((f) => [f.name, { status: "mapping" }])));
    await Promise.all(files.map(async (f) => {
      const res = await fetch("/api/upload/propose", { method: "POST", headers: { "content-type": "application/json" },
                                                       body: JSON.stringify(f.table ? { table: { table: f.name, version: f.table.version } }
                                                                                      : { file: { name: f.name, content: f.content } }) });
      const data = await res.json();
      setProposals((p) => ({ ...p, [f.name]: res.ok ? { status: "done", mapping: data.mapping, seconds: data.seconds }
                                                    : { status: "error", error: data.error ?? res.statusText } }));
    }));
    setBusy(null);
  }

  // The mapping editor (§23.8): every change goes through here, on a copy; the file is marked edited (kept on the
  // load's provenance) and has to be validated again.
  function editMapping(file: string, change: (m: FileMapping) => void) {
    setProposals((p) => {
      const m = structuredClone(p[file].mapping!);
      change(m);
      return { ...p, [file]: { ...p[file], mapping: m, edited: true } };
    });
    setReport(null); setResult(null);
  }

  // A validator suggestion applied to every file's mapping, then validated again.
  async function applyCheckFix(fix: CheckFix) {
    let changed = 0;
    const next = { ...proposals };
    for (const f of files) {
      const p = next[f.name];
      if (!p?.mapping) continue;
      const r = applyFix(p.mapping, fix);
      if (r.changed) { next[f.name] = { ...p, mapping: r.mapping, edited: true }; changed += r.changed; }
    }
    if (!changed) { setError(`No record type names its ${fix.type} with a fixed subject type: add refs.subject_system in the mapping by hand.`); return; }
    setProposals(next);
    await validateWith(Object.values(next).map((p) => p.mapping).filter((m): m is FileMapping => !!m));
  }

  const validateAll = () => validateWith(mappings);
  async function validateWith(mappings: FileMapping[], w = windows) {
    setBusy("validate"); setError(null);
    const res = await fetch("/api/upload/validate", { method: "POST", headers: { "content-type": "application/json" },
                                                      body: JSON.stringify({ name, ...sources(), mappings, windows: w }) });
    const data = await res.json();
    if (res.ok) { setReport(data); setView("validate"); } else setError(data.error ?? res.statusText);
    setBusy(null);
  }

  // Changes since the last Databricks load: the server reads only the changed rows (Change Data Feed), merges
  // them into the stored rows and validates; the report shows what approving would add, change or remove.
  async function checkChanges() {
    setBusy("changes"); setError(null);
    const res = await fetch("/api/databricks/changes", { method: "POST", headers: { "content-type": "application/json" },
                                                         body: JSON.stringify({ batch: pending?.batch ?? undefined }) });
    const data = await res.json();
    setBusy(null);
    if (!res.ok || data.error) { setError(data.error ?? res.statusText); return; }
    if (data.nothing) { setError(null); await refreshPending(); return; }
    setName(data.batch);
    setFiles((data.changes as ChangeCount[]).map((c) => ({ name: c.table })));
    setProposals(Object.fromEntries((data.mappings as FileMapping[]).map((m) => [m.file, { status: "done", mapping: m }])));
    setResult(null); setGraph(null);
    setIncremental({ ranges: data.ranges, changes: data.changes });
    setReport(data.report); setView("validate");
  }

  async function runAll() {
    const r = report?.removal;
    if (r && !incremental && !window.confirm(`Replace the source "${r.source}"?\n\nThis REMOVES ${r.removed.toLocaleString()} of its ` +
        `${r.total.toLocaleString()} records${r.files.length ? ` (from ${r.files.join(", ")})` : ""} and keeps only what's in these files.\n\n` +
        `If this is different data, even related data, cancel and give it a new source name: it's added beside ` +
        `"${r.source}" and linked to its subjects where the records refer to them.`)) return;
    setBusy("run"); setError(null);
    const edited_files = files.filter((f) => proposals[f.name]?.edited).map((f) => f.name);
    const res = incremental
      ? await fetch("/api/databricks/changes", { method: "POST", headers: { "content-type": "application/json" },
                                                 body: JSON.stringify({ apply: true, ranges: incremental.ranges, batch: name }) })
      : await fetch("/api/upload/run", { method: "POST", headers: { "content-type": "application/json" },
                                         body: JSON.stringify({ name, ...sources(), mappings, edited_files, confirm_removal: !!report?.removal, windows }) });
    const body = await res.json();
    const data = incremental ? (body.result ?? body) : body;
    if (res.ok && data.ok !== false) {
      if (incremental) { setIncremental(null); refreshPending(); }
      setResult(data); setView("result"); onChanged(); refreshKnown();
      if (data.customers?.length) await showCustomer(data.customers[0].email);
      else if (data.subjects?.length) await showSubject(data.subjects[0].id);
    } else setError(data.error ?? res.statusText);
    if (!incremental && data.ok) refreshPending();
    setBusy(null);
  }

  async function removeBatch() {
    if (!result) return;
    if (!window.confirm(`Remove ${result.source ? `the source "${result.source}"` : result.scenario}? Can't be undone; the files can be loaded again.`)) return;
    setBusy("remove");
    await fetch(`/api/upload?scenario=${encodeURIComponent(result.scenario)}${result.source ? `&source=${encodeURIComponent(result.source)}` : ""}`,
                { method: "DELETE" });
    setResult(null); setGraph(null); setView("validate"); onChanged(); refreshKnown();
    setBusy(null);
  }

  async function showSubject(id: string) {
    const res = await fetch(`/api/graph/subject?id=${encodeURIComponent(id)}`);
    if (res.ok) setGraph({ email: id, ...(await res.json()) });
  }

  async function showCustomer(email: string) {
    const res = await fetch(`/api/graph/customer?email=${encodeURIComponent(email)}`);
    if (res.ok) setGraph({ email, ...(await res.json()) });
  }

  const step = result ? 4 : report ? 3 : allMapped ? 2 : files.length ? 1 : 0;
  const changedTables = pending?.ranges?.length ?? 0;
  const t = report?.target;
  const nothingNew = !!t && t.new === 0 && t.changed === 0 && t.removed === 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex flex-wrap items-center gap-3 rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Connect a source</h2>
        <ol className="flex items-center gap-1 text-[11px]">
          {["Files", "Mapping (Claude)", "Validate + dry run", "Load into Neo4j"].map((s, i) => (
            <li key={s} className={`rounded-full px-2 py-0.5 ${step > i ? "bg-sky-600 text-white" : step === i ? "bg-zinc-700 text-zinc-100" : "text-zinc-500"}`}>
              {i + 1}. {s}</li>
          ))}
        </ol>
        <button onClick={onClose} className="ml-auto rounded-md bg-zinc-800 px-3 py-1 text-xs">Close</button>
      </header>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs">
        <button onClick={useSamples} disabled={!!busy} className="rounded-md bg-zinc-700 px-3 py-1 font-semibold disabled:opacity-40">
          {busy === "files" ? "Loading…" : "Use sample exports (6 files)"}</button>
        {dbx?.configured && (
          <button onClick={useDatabricks} disabled={!!busy} className="rounded-md bg-orange-600 px-3 py-1 font-semibold text-white disabled:opacity-40"
                  title={`Read every table in ${dbx.schema} through the Databricks SQL API`}>
            {busy === "files" ? "Reading…" : "Load from Databricks"}</button>
        )}
        {/* Only when a table changed since the last Databricks load (Change Data Feed). */}
        {dbx?.configured && pending?.batch && changedTables > 0 && (
          <button onClick={checkChanges} disabled={!!busy}
                  className="rounded-md border border-orange-700 px-3 py-1 font-semibold text-orange-300 disabled:opacity-40"
                  title="Read only the rows changed in Databricks since the last load (Change Data Feed)">
            {busy === "changes" ? "Reading changes…"
              : `Load changes from Databricks (${changedTables} table${changedTables > 1 ? "s" : ""} changed${!DEMO && pending?.batch ? ` in "${pending.batch}"` : ""})`}</button>
        )}
        <label className="cursor-pointer rounded-md border border-zinc-700 px-3 py-1">
          Upload files…
          <input type="file" multiple accept=".csv,.jsonl,.ndjson" className="hidden" onChange={(e) => pickFiles(e.target.files)} />
        </label>
        <span className="text-zinc-500">{DEMO ? "batch" : "source"}</span>
        <input value={name} onChange={(e) => { setName(e.target.value); setReport(null); }} list={DEMO ? undefined : "known-sources"}
               placeholder={DEMO ? undefined : "e.g. Loan applications"}
               title={DEMO ? undefined : "The same name updates that source; a new name adds a source beside the others"}
               className="w-44 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono" />
        {!DEMO && <datalist id="known-sources">{known.map((k) => <option key={k} value={k} />)}</datalist>}
        <span className="ml-auto flex gap-2">
          <button onClick={proposeAll} disabled={!files.length || !!busy || !!incremental}
                  className="rounded-md bg-sky-600 px-3 py-1 font-semibold text-white disabled:opacity-40">
            {busy === "propose" ? "Claude is mapping…" : allMapped ? "Re-map with Claude" : "Map with Claude"}</button>
          <button onClick={validateAll} disabled={!allMapped || !!busy || !name.trim()}
                  title={!name.trim() ? (DEMO ? "Name the batch" : "Name the source") : undefined}
                  className="rounded-md bg-amber-600 px-3 py-1 font-semibold text-white disabled:opacity-40">
            {busy === "validate" ? "Checking…" : "Validate + dry run"}</button>
          <button onClick={runAll} disabled={!report?.ok || nothingNew || !!busy}
                  className={`rounded-md px-3 py-1 font-semibold text-white disabled:opacity-40 ${report?.removal ? "bg-red-600" : "bg-emerald-600"}`}>
            {busy === "run" ? "Loading…" : nothingNew ? "Nothing new to load"
              : incremental ? `Approve changes to ${report?.target?.source ?? report?.target?.scenario ?? name}`
              : report?.removal ? `Approve + replace "${report.removal.source}" (removes ${report.removal.removed.toLocaleString()})`
              : report?.target ? `Approve + update ${report.target.source ? `"${report.target.source}"` : report.target.scenario}`
              : DEMO ? "Approve + load into Neo4j" : "Approve + add source"}</button>
        </span>
      </div>
      {error && <p className="border-b border-red-900 bg-red-950/50 px-4 py-1.5 text-xs text-red-300">{error}</p>}

      {!files.length ? (
        <div className="p-6 text-sm text-zinc-400">
          <p>Bring history in as the files a team already exports: ticket events, payments, the agent&apos;s tool-call log,
            fraud screening, subscriptions, usage. No pre-labelled decisions and no custom connector.</p>
          <p className="mt-2">Claude proposes how each file maps onto the event contract, with a reason per field. You review it,
            a deterministic validator checks it and dry-runs the detector, and only then is anything written.</p>
          {dbx?.configured && <p className="mt-2 text-xs text-zinc-400">Load from Databricks reads every table in{" "}
            <b className="font-mono text-zinc-100">{dbx.schema}</b> (catalog.schema, set in Settings).</p>}
          <p className="mt-2 text-xs text-zinc-500">The sample exports are simulated Streamly data (16 new customers, spring 2026).
            Everything shown after mapping is computed live from the files.</p>
          {!DEMO && <p className="mt-2 text-xs text-amber-300">Workspace <span className="font-mono">{TENANT}</span>: each load is a named
            source of its history ({known.length ? <>now: {known.map((k) => `"${k}"`).join(", ")}</> : "none yet"}). The same name updates
            that source; a new name adds one beside the others. Decisions are worked out over all sources together; build the trees
            with the pipeline.</p>}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[230px_1fr]">
          {/* File list */}
          <nav className="min-h-0 space-y-1 overflow-y-auto border-r border-zinc-800 p-2 text-xs">
            {files.map((f) => {
              const p = proposals[f.name], x = parsed[f.name];
              return (
                <button key={f.name} onClick={() => setView(f.name)}
                        className={`w-full rounded-md px-2 py-1.5 text-left ${view === f.name ? "bg-zinc-800" : "hover:bg-zinc-800/50"}`}>
                  <span className="block truncate font-mono">{f.name}</span>
                  <span className="text-[10px] text-zinc-500">
                    {incremental ? (() => { const c = incremental.changes.find((y) => y.table === f.name);
                      return c ? `v${c.from}–${c.to}: +${c.inserted} · ~${c.updated} · −${c.deleted}` : "unchanged"; })()
                      : x === undefined ? "" : typeof x === "string" ? "unreadable" : `${rowCount(f).toLocaleString()} rows${f.table ? ` · v${f.table.version}` : ""}`}
                    {" · "}{!p ? "not mapped" : p.status === "mapping" ? "Claude is mapping…" : p.status === "error" ? "mapping failed"
                      : `${p.mapping!.records.length} record types${p.edited ? " · edited" : ""}`}
                  </span>
                  {p?.status === "mapping" && <span className="mt-1 block h-0.5 animate-pulse bg-sky-600" />}
                </button>
              );
            })}
            {report && (
              <button onClick={() => setView("validate")}
                      className={`w-full rounded-md px-2 py-1.5 text-left ${view === "validate" ? "bg-zinc-800" : "hover:bg-zinc-800/50"}`}>
                <span className={report.ok ? "text-emerald-400" : "text-red-400"}>{report.ok ? "✓" : "✕"}</span> Validator + dry run
              </button>
            )}
            {result && (
              <button onClick={() => setView("result")}
                      className={`w-full rounded-md px-2 py-1.5 text-left ${view === "result" ? "bg-zinc-800" : "hover:bg-zinc-800/50"}`}>
                <span className="text-sky-400">●</span> Loaded · {result.source ?? result.scenario}
              </button>
            )}
          </nav>

          {/* Detail */}
          <div className="min-h-0 overflow-y-auto p-4">
            {view === "validate" && report && incremental && (
              <p className="mb-3 rounded-md bg-orange-950/60 px-3 py-2 text-xs text-orange-200">
                Changes since the last load, read from Databricks&apos; Change Data Feed:{" "}
                {incremental.changes.map((c) => `${c.table} (v${c.from}–${c.to}: ${c.inserted} new, ${c.updated} changed, ${c.deleted} deleted)`).join("; ")}.
                Merged into the rows already loaded and re-detected over the full history with the last approved mapping.</p>
            )}
            {view === "validate" && report && <ValidationView report={report} onFix={incremental ? undefined : applyCheckFix}
              onWindows={DEMO || incremental ? undefined : (w) => { const all = { ...windows, ...w }; setWindows(all); validateWith(mappings, all); }}
              busy={!!busy} />}
            {view === "result" && result && (
              <ResultView result={result} graph={graph} active={active} onCustomer={showCustomer} onSubject={showSubject} onRemove={removeBatch} busy={busy} />
            )}
            {view !== "validate" && view !== "result" && pf && (typeof pf === "string"
              ? <p className="text-sm text-red-400">Could not read {view}: {pf}</p>
              : mapping ? <MappingView file={pf} mapping={mapping} proposal={proposals[view]}
                                       total={files.find((f) => f.name === view)?.table?.rows}
                                       onChange={(change) => editMapping(view, change)} />
              : <FilePreview file={pf} status={proposals[view]} />)}
          </div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ before mapping: the raw file
function FilePreview({ file, status }: { file: ParsedFile; status?: Proposal }) {
  return (
    <div>
      <p className="font-mono text-sm">{file.name} <span className="text-xs text-zinc-500">· {file.format} · {file.columns.length} columns · showing {Math.min(8, file.rows.length)} example rows</span></p>
      {status?.status === "error" && <p className="mt-1 text-xs text-red-400">{status.error}</p>}
      <p className="mt-1 text-xs text-zinc-500">{status?.status === "mapping" ? "Claude is reading the columns and sample rows…" : "Not mapped yet."}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="text-[11px]">
          <thead><tr>{file.columns.map((c) => <th key={c} className="whitespace-nowrap border-b border-zinc-800 px-2 py-1 text-left font-mono text-zinc-400">{c}</th>)}</tr></thead>
          <tbody>{file.rows.slice(0, 8).map((r, i) => (
            <tr key={i}>{file.columns.map((c) => <td key={c} className="max-w-48 truncate whitespace-nowrap border-b border-zinc-900 px-2 py-1 font-mono">{fmt(r[c])}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

const fmt = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

// ------------------------------------------------------------------ the mapping
function MappingView({ file, mapping, proposal, total, onChange }: {
  file: ParsedFile; mapping: FileMapping; proposal: Proposal; total?: number;   // total: a table's rows (file holds a preview)
  onChange: (change: (m: FileMapping) => void) => void;
}) {
  const { events, problems } = useMemo(() => mapFile(file, mapping), [file, mapping]);
  const skipped = file.rows.filter((r) => !mapping.records.some((x) => matches(r, x.when)) && mapping.skipped.some((s) => matches(r, s.when))).length;
  const unmatched = file.rows.filter((r) => !mapping.records.some((x) => matches(r, x.when)) && !mapping.skipped.some((s) => matches(r, s.when))).length;
  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-sm">{file.name} <span className="text-xs text-zinc-500">· {file.format} · {(total ?? file.rows.length).toLocaleString()} rows ·
          source <span className="text-zinc-300">{mapping.source}</span> · mapped by Claude in {proposal.seconds}s{proposal.edited ? " · edited by you" : ""}</span></p>
        <p className="mt-1 text-sm text-zinc-300">{mapping.reason}</p>
        <p className="mt-1 text-xs text-zinc-500">
          {total !== undefined && <span>In the {file.rows.length} example rows (the table stays in Databricks; Validate checks all {total.toLocaleString()}): </span>}
          {events.length} rows → contract events{skipped ? ` · ${skipped} skipped on purpose` : ""}
          {unmatched ? <span className="text-amber-400"> · {unmatched} rows match no record type</span> : null}
          {problems.length ? <span className="text-red-400"> · {problems.length} values could not be converted</span> : null}
        </p>
      </div>
      {mapping.records.map((rec, ri) => (
        <RecordCard key={ri} file={file} rec={rec} count={events.filter((e) => e.record === rec.name).length}
                    example={events.find((e) => e.record === rec.name)}
                    onChange={(change) => onChange((m) => change(m.records[ri]))} />
      ))}
      {mapping.skipped.length > 0 && (
        <div className="rounded-lg border border-zinc-800 p-3 text-xs">
          <p className="font-semibold text-zinc-400">Skipped on purpose</p>
          {mapping.skipped.map((s, i) => (
            <p key={i} className="mt-1"><span className="font-mono">{s.when.column} = &quot;{s.when.equals}&quot;</span>
              <span className="text-zinc-500"> · {s.reason}</span></p>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordCard({ file, rec, count, example, onChange }: {
  file: ParsedFile; rec: RecordMap; count: number; example?: ReturnType<typeof mapFile>["events"][number];
  onChange: (change: (r: RecordMap) => void) => void;
}) {
  const [showExample, setShowExample] = useState(false);
  const [open, setOpen] = useState<number | null>(null);   // the field being edited
  const spec = DATA_FIELDS[rec.event_type];
  const mappedData = new Set(rec.fields.map((f) => f.target));
  const missingRequired = spec.required.filter((d) => !mappedData.has(`data.${d}`));
  const setField = (fi: number, f: FieldMap) => onChange((r) => { r.fields[fi] = { ...f, reason: f.reason.endsWith("(edited)") || f.reason.startsWith("added") ? f.reason : `${f.reason} (edited)` }; });
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-sm">
        <span className="text-zinc-400">{rec.when ? <>Rows where <span className="font-mono text-zinc-200">{rec.when.column}</span> = <span className="font-mono text-zinc-200">&quot;{rec.when.equals}&quot;</span></> : "Every row"}</span>
        <span className="text-xs text-zinc-500">({count})</span>
        <span className="text-zinc-500">→</span>
        <span className="rounded bg-sky-900 px-2 py-0.5 font-mono text-xs text-sky-100">{rec.event_type}</span>
        <span className="w-full text-xs italic text-zinc-500">{rec.reason}</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
            <th className="px-3 py-1">Source</th><th className="px-1 py-1" /><th className="px-2 py-1">Contract field</th>
            <th className="px-2 py-1">As</th><th className="px-2 py-1">Value translations</th><th className="px-2 py-1">Why</th><th />
          </tr>
        </thead>
        <tbody>
          {rec.fields.map((f, fi) => {
            const required = f.target.startsWith("data.") && spec.required.includes(f.target.slice(5));
            return [
              <tr key={fi} className={`border-t border-zinc-900 align-top ${open === fi ? "bg-zinc-900/60" : ""}`}>
                <td className="px-3 py-1.5">
                  {f.column !== null ? (
                    <select value={f.column} onChange={(e) => setField(fi, { ...f, column: e.target.value })}
                            className={`max-w-52 rounded border bg-zinc-900 px-1 py-0.5 font-mono ${file.columns.includes(f.column) ? "border-zinc-700" : "border-red-600"}`}>
                      {!file.columns.includes(f.column) && <option value={f.column}>{f.column} (missing)</option>}
                      {file.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : f.template !== null ? <span className="font-mono text-zinc-300">{f.template}</span>
                    : <span className="font-mono text-zinc-400">&quot;{f.value}&quot; <span className="text-zinc-600">fixed</span></span>}
                </td>
                <td className="px-1 py-1.5 text-zinc-600">→</td>
                <td className={`whitespace-nowrap px-2 py-1.5 font-mono ${targetClass(f.target)}`}>{f.target}{required && <span className="text-amber-400" title="required"> *</span>}</td>
                <td className="px-2 py-1.5 text-zinc-500">{f.transform === "string" ? "" : f.transform}</td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {f.aliases.map((a, ai) => (
                      <span key={ai} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px]">
                        {a.from} <span className="text-zinc-500">→</span> <span className="text-emerald-300">{a.to}</span></span>
                    ))}
                    {f.otherwise && <span className="rounded border border-dashed border-zinc-700 px-1.5 py-0.5 text-[10px]">
                      otherwise <span className="text-emerald-300">{f.otherwise}</span></span>}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-zinc-400">{f.reason}</td>
                <td className="px-2 py-1.5 text-right">
                  <button onClick={() => setOpen(open === fi ? null : fi)} title="Edit this field"
                          className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">{open === fi ? "Done" : "✎"}</button>
                </td>
              </tr>,
              open === fi && (
                <tr key={`${fi}-edit`} className="bg-zinc-900/60">
                  <td colSpan={7} className="px-3 pb-3">
                    <FieldEditor field={f} columns={file.columns} onChange={(next) => setField(fi, next)}
                                 onRemove={() => { setOpen(null); onChange((r) => { r.fields.splice(fi, 1); }); }} />
                  </td>
                </tr>
              ),
            ];
          })}
          {missingRequired.map((d) => (
            <tr key={d} className="border-t border-zinc-900">
              <td className="px-3 py-1.5 text-red-400">no column</td><td className="px-1 text-zinc-600">→</td>
              <td className="px-2 py-1.5 font-mono text-red-300">data.{d} *</td>
              <td colSpan={3} className="px-2 text-red-400">required for {rec.event_type}</td>
              <td className="px-2 text-right">
                <button onClick={() => { onChange((r) => { r.fields.push(newField(`data.${d}`, file.columns)); }); setOpen(rec.fields.length); }}
                        className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-200">Add</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <AddField rec={rec} onAdd={(target) => { onChange((r) => { r.fields.push(newField(target, file.columns)); }); setOpen(rec.fields.length); }} />
      {example && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <button onClick={() => setShowExample(!showExample)} className="text-xs text-sky-400">
            {showExample ? "Hide example" : `Show row ${example.row} → contract event`}</button>
          {showExample && (
            <div className="mt-2 grid grid-cols-2 gap-3 text-[11px]">
              <pre className="overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-zinc-400">{JSON.stringify(
                Object.fromEntries(Object.entries(example.event.raw).filter(([, v]) => v !== "" && v !== null)), null, 1)}</pre>
              <pre className="overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-zinc-200">{JSON.stringify(
                { ...example.event, raw: undefined, received_at: undefined }, null, 1)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One field: where its value comes from (a column, a fixed value, or a template of columns), how it's read, and
// value translations with an "otherwise" value. Any change is checked again by Validate.
function FieldEditor({ field: f, columns, onChange, onRemove }: {
  field: FieldMap; columns: string[]; onChange: (f: FieldMap) => void; onRemove: () => void;
}) {
  const mode = modeOf(f);
  const choices = CHOICES[f.target];
  const input = "rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono";
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2 pt-2">
      <label className="flex items-center gap-2">
        <span className="text-zinc-500">From</span>
        <select value={mode} onChange={(e) => onChange(withMode(f, e.target.value as SourceMode, columns))} className={input}>
          <option value="column">a column</option><option value="value">a fixed value</option><option value="template">a template</option>
        </select>
        {mode === "column" && (
          <select value={f.column ?? ""} onChange={(e) => onChange({ ...f, column: e.target.value })} className={`${input} max-w-52`}>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {mode === "value" && (choices
          ? <select value={f.value ?? ""} onChange={(e) => onChange({ ...f, value: e.target.value })} className={input}>
              {choices.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          : <input value={f.value ?? ""} onChange={(e) => onChange({ ...f, value: e.target.value })} placeholder="value" className={`${input} w-44`} />)}
        {mode === "template" && (
          <input value={f.template ?? ""} onChange={(e) => onChange({ ...f, template: e.target.value })} placeholder="e.g. system:{Column}"
                 title="Column names in braces are replaced by the row's values" className={`${input} w-56`} />
        )}
      </label>
      <label className="flex items-center gap-2">
        <span className="text-zinc-500">Read as</span>
        <select value={f.transform} onChange={(e) => onChange({ ...f, transform: e.target.value as FieldMap["transform"] })} className={input}>
          {TRANSFORMS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <div className="space-y-1">
        <span className="text-zinc-500">Value translations</span>
        {f.aliases.map((a, ai) => (
          <div key={ai} className="flex items-center gap-1">
            <input value={a.from} onChange={(e) => onChange({ ...f, aliases: f.aliases.map((x, i) => (i === ai ? { ...x, from: e.target.value } : x)) })}
                   placeholder="source value" className={`${input} w-36`} />
            <span className="text-zinc-500">→</span>
            <input value={a.to} onChange={(e) => onChange({ ...f, aliases: f.aliases.map((x, i) => (i === ai ? { ...x, to: e.target.value } : x)) })}
                   placeholder="becomes" className={`${input} w-32`} />
            <button onClick={() => onChange({ ...f, aliases: f.aliases.filter((_, i) => i !== ai) })} className="px-1 text-zinc-500 hover:text-red-400">✕</button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <button onClick={() => onChange({ ...f, aliases: [...f.aliases, { from: "", to: "" }] })} className="rounded bg-zinc-800 px-2 py-0.5">+ translation</button>
          {f.aliases.length > 0 && <label className="flex items-center gap-1"><span className="text-zinc-500">otherwise</span>
            <input value={f.otherwise ?? ""} onChange={(e) => onChange({ ...f, otherwise: e.target.value || null })} placeholder="(keep the value)"
                   className={`${input} w-32`} /></label>}
        </div>
      </div>
      <button onClick={onRemove} className="ml-auto self-end rounded border border-red-900 px-2 py-0.5 text-red-300 hover:bg-red-950">Remove field</button>
    </div>
  );
}

// Add a contract field this record type doesn't map yet (open families, e.g. data.context.<name>, take a name).
function AddField({ rec, onAdd }: { rec: RecordMap; onAdd: (target: string) => void }) {
  const { fixed, open } = targetsFor(rec.event_type);
  const used = new Set(rec.fields.map((f) => f.target));
  const available = fixed.filter((t) => !used.has(t));
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const isOpen = open.includes(target);
  const full = isOpen ? `${target}${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}` : target;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-3 py-2 text-xs">
      <span className="text-zinc-500">Add a field</span>
      <select value={target} onChange={(e) => { setTarget(e.target.value); setName(""); }}
              className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono">
        <option value="">choose…</option>
        {open.map((t) => <option key={t} value={t}>{t}&lt;name&gt;</option>)}
        {available.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      {isOpen && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name, e.g. credit_score"
                        className="w-40 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono" />}
      <button disabled={!target || (isOpen && !name.trim()) || used.has(full)} onClick={() => { onAdd(full); setTarget(""); setName(""); }}
              className="rounded bg-zinc-700 px-2 py-0.5 font-semibold disabled:opacity-40">Add</button>
    </div>
  );
}

// ------------------------------------------------------------------ validator + dry run
// Outcome windows (§23.11): how long after a decision each outcome type is still credited to it when the subject had
// several decisions. Changing one validates again; approving saves it with the outcome type.
function OutcomeWindows({ windows, onApply, busy }: { windows: Record<string, number>; onApply: (w: Record<string, number>) => void; busy?: boolean }) {
  const [draft, setDraft] = useState(windows);
  const changed = Object.keys(draft).some((t) => draft[t] !== windows[t]);
  return (
    <div className="rounded-lg border border-zinc-800 p-3 text-xs">
      <p className="mb-1 font-semibold uppercase tracking-wider text-zinc-400">Outcome windows</p>
      <p className="mb-2 text-zinc-500">How long after a decision an outcome is still credited to it when its subject had several decisions
        (an outcome about a subject with a single decision is credited to it whatever the delay). Saved with the outcome type on approval.</p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {Object.keys(draft).map((t) => (
          <label key={t} className="flex items-center gap-1.5">
            <span className="font-mono text-zinc-300">{t}</span>
            <input type="number" min={1} max={3650} value={draft[t]} onChange={(e) => setDraft({ ...draft, [t]: Number(e.target.value) })}
                   className="w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono" />
            <span className="text-zinc-500">days</span>
          </label>
        ))}
        <button disabled={!changed || busy} onClick={() => onApply(Object.fromEntries(Object.entries(draft).filter(([t, v]) => v !== windows[t] && v >= 1)))}
                className="rounded bg-sky-700 px-2 py-0.5 font-semibold text-white disabled:opacity-40">Validate with these windows</button>
      </div>
    </div>
  );
}

function ValidationView({ report, onFix, onWindows, busy }: {
  report: ReportView; onFix?: (fix: CheckFix) => void; onWindows?: (w: Record<string, number>) => void; busy?: boolean;
}) {
  const d = report.dryRun;
  return (
    <div className="space-y-4">
      <p className={`rounded-md px-3 py-2 text-sm ${report.ok && !report.removal ? "bg-emerald-950 text-emerald-200" : "bg-red-950 text-red-200"}`}>
        {!report.ok ? "Fix the errors below (edit the mapping or re-map) before loading."
          : report.removal ? `Careful: these files would REPLACE the source "${report.removal.source}", removing ` +
              `${report.removal.removed.toLocaleString()} of its ${report.removal.total.toLocaleString()} records` +
              `${report.removal.files.length ? ` (from ${report.removal.files.join(", ")})` : ""}. If this is different data, ` +
              `even data related to "${report.removal.source}", change the source name to a new one and validate again: it's added ` +
              `beside "${report.removal.source}", and records that refer to its subjects (the same IDs) are linked to them.`
          : report.target && !report.target.new && !report.target.changed && !report.target.removed
            ? `Nothing new: these files are already loaded as ${report.target.scenario}. Nothing to write.`
          : report.target ? `All checks passed. These files update ${report.target.scenario}: ${report.target.new} new, ` +
              `${report.target.changed} changed${report.target.removed ? `, ${report.target.removed} removed` : ""} ` +
              `(${report.target.unchanged} unchanged). Nothing has been written yet: approve to update.`
          : "All checks passed. Nothing has been written yet: approve to load."}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-zinc-800 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Per file</p>
          {report.files.map((f) => (
            <div key={f.file} className="mb-2">
              <p className="font-mono text-xs">{f.file}</p>
              <ul className="mt-1 space-y-0.5">{f.checks.map((c, i) => <CheckLine key={i} c={c} />)}</ul>
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-zinc-800 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Across files</p>
          <ul className="space-y-1">{report.checks.map((c, i) => <CheckLine key={i} c={c} onFix={onFix} />)}</ul>
        </div>
      </div>
      {onWindows && d.windows && Object.keys(d.windows).length > 0 && <OutcomeWindows windows={d.windows} onApply={onWindows} busy={busy} />}
      <div className="rounded-lg border border-zinc-800 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Dry run · the detector over the mapped events</p>
        <div className="grid grid-cols-4 gap-2 text-center">
          {[["events", d.events], ["customers", d.customers], ["decisions", d.decisions.reduce((s, x) => s + x.count, 0)],
            ["outcomes", d.outcomes.reduce((s, x) => s + x.count, 0)], ["overrides", d.overrides], ["identity links", d.identityLinks],
            ["new options", d.schemaProposals.length], ["to review", d.review.reduce((s, x) => s + x.count, 0)]].map(([k, v]) => (
            <div key={k as string} className="rounded-md bg-zinc-950 p-2"><p className="text-lg font-semibold">{v as number}</p>
              <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k as string}</p></div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div>{d.decisions.map((x) => <p key={x.decision_type + x.stage}><span className="font-mono">{x.decision_type}</span>
            <span className="text-zinc-500"> · {x.stage.toLowerCase()}</span> <b>{x.count}</b></p>)}</div>
          <div>{d.outcomes.map((x) => <p key={x.outcome_type}><span className="font-mono">{x.outcome_type}</span> <b>{x.count}</b></p>)}
            {d.review.map((x) => <p key={x.reason} className="text-amber-400">review: {x.reason} ({x.count})</p>)}
            {d.schemaProposals.map((x) => <p key={x} className="text-amber-400">proposed option: {x}</p>)}</div>
        </div>
        <p className="mb-1 mt-3 text-[10px] uppercase tracking-wide text-zinc-500">Preview: decisions it would record</p>
        <div className="space-y-1.5">{d.preview.map((p) => (
          <div key={p.decision_id} className="rounded-md bg-zinc-950 p-2 text-xs">
            <p className="text-zinc-300">{p.summary}</p>
            <p className="mt-0.5 text-[10px] text-zinc-500"><span className="font-mono">{p.decision_type}</span>
              {p.outcomes.length ? <> · led to <span className="text-amber-300">{p.outcomes.join(", ")}</span></> : null}</p>
          </div>
        ))}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ after loading
function ResultView({ result, graph, active, onCustomer, onSubject, onRemove, busy }: {
  result: RunResult; graph: { email: string; nodes: ViewNode[]; rels: ViewRel[] } | null; active: boolean;
  onCustomer: (email: string) => void; onSubject: (id: string) => void; onRemove: () => void; busy: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {   // Esc closes the expanded graph
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Streamly's customers, or (any domain) the top-level subjects loaded, e.g. applications.
  const customers = result.customers.length || !result.subjects?.length ? (
    <div className="flex flex-wrap gap-1">{result.customers.map((c) => (
      <button key={c.email} onClick={() => onCustomer(c.email)}
              className={`rounded border px-2 py-0.5 text-[11px] ${graph?.email === c.email ? "border-sky-600 bg-sky-950" : "border-zinc-700"}`}>
        {c.name ?? c.email}</button>
    ))}</div>
  ) : (
    <div className="flex flex-wrap gap-1">{result.subjects.map((x) => (
      <button key={x.id} onClick={() => onSubject(x.id)}
              className={`rounded border px-2 py-0.5 text-[11px] ${graph?.email === x.id ? "border-sky-600 bg-sky-950" : "border-zinc-700"}`}>
        {x.label} {x.key}</button>
    ))}</div>
  );
  const expandButton = (
    <button onClick={() => setExpanded((x) => !x)} title={expanded ? "Close (Esc)" : "Expand"}
            className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs font-normal normal-case tracking-normal text-zinc-300 hover:bg-zinc-800">
      {expanded ? "✕ Close" : "⤢ Expand"}</button>
  );
  return (
    <>
    <div className="grid h-full min-h-[520px] grid-cols-[1fr_1.3fr] gap-3">
      <div className="min-h-0 space-y-3 overflow-y-auto">
        <p className="rounded-md bg-sky-950 px-3 py-2 text-sm text-sky-100">
          {result.source ? <>Source <span className="font-mono">{result.source}</span> written to <span className="font-mono">{result.scenario}</span>;
            the workspace now holds</> : <>Written to Neo4j as <span className="font-mono">{result.scenario}</span>:</>} {result.counts.events} events,
          {" "}{result.counts.decisions} decisions, {result.counts.outcomes} outcomes, {result.counts.led_to} LED_TO links.</p>
        {result.analysis?.stale && <p className="rounded-md bg-amber-950/50 px-3 py-2 text-xs text-amber-200">The decision trees and
          similar-case links were built before this change: they describe the earlier data until the pipeline rebuilds them.</p>}
        {result.analysis?.noTrees && <p className="text-xs text-zinc-500">No decision trees yet for this workspace: build them with the pipeline.</p>}
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {result.customers.length || !result.subjects?.length ? `Customers (${result.customers.length})` : `Subjects (first ${result.subjects.length})`}</p>
          {customers}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">Decision trees updated</p>
          {result.branches.length === 0 && <p className="text-xs text-zinc-500">No branches changed.</p>}
          <div className="space-y-1.5">{result.branches.map((b) => (
            <div key={b.point_id} className="rounded-md bg-zinc-950 p-2 text-[11px]">
              <p className="text-zinc-400">{b.tree}</p><p>{b.branch}</p>
              <p className="text-zinc-300">decisions <b>{b.before.support.toLocaleString()} → {b.after.support.toLocaleString()}</b>
                {" · "}disputes {pct(b.before.dispute_rate)} → {pct(b.after.dispute_rate)}{" · "}churn {pct(b.before.churn_rate)} → {pct(b.after.churn_rate)}</p>
            </div>
          ))}</div>
        </div>
        <button onClick={onRemove} disabled={!!busy} className="rounded-md bg-zinc-800 px-3 py-1 text-xs disabled:opacity-40">
          {busy === "remove" ? "Removing…" : result.source ? "Remove this source" : "Remove this batch"}</button>
      </div>
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800">
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-800/70 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          <span>Journey · live from Neo4j {graph && <span className="font-normal normal-case text-zinc-500">· {graph.email}</span>}</span>
          {expandButton}
        </div>
        <div className="min-h-0 flex-1">{active && !expanded && graph && graph.nodes.length > 0 && <GraphView nodes={graph.nodes} rels={graph.rels} />}</div>
      </div>
    </div>
    {expanded && (
      <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 p-4 backdrop-blur">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
            Journey · live from Neo4j <span className="font-normal normal-case text-zinc-500">· {result.scenario}{graph ? ` · ${graph.email}` : ""}</span></h2>
          {expandButton}
        </div>
        <div className="mb-3">{customers}</div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
          {graph && graph.nodes.length > 0 && <GraphView nodes={graph.nodes} rels={graph.rels} />}</div>
      </div>
    )}
    </>
  );
}
