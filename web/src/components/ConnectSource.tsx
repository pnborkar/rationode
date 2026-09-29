"use client";

// "Connect a source" (demo spec §16.2): upload exports, Claude proposes a mapping per file, you see
// and adjust the mapping, the validator checks it and dry-runs the detector, then you approve and
// it is written to Neo4j under upload:<name>.
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { DATA_FIELDS } from "@/lib/contract";
import { mapFile, matches, parseFile, type FieldMap, type FileMapping, type ParsedFile, type RecordMap } from "@/lib/mapping";
import type { Check, Validation } from "@/lib/validator";
import type { ViewNode, ViewRel } from "./GraphView";

const GraphView = dynamic(() => import("./GraphView"), { ssr: false });

const SAMPLE_DIR = "/samples/streamly-spring";
const SAMPLE_FILES = ["zendesk_ticket_events.csv", "stripe_activity.csv", "support_agent_tool_calls.jsonl",
                      "fraudguard_screening.csv", "subscriptions.csv", "app_usage_weekly.csv"];

type Proposal = { status: "mapping" | "done" | "error"; mapping?: FileMapping; seconds?: number; error?: string; edited?: boolean };
type Stats = { support: number; dispute_rate: number | null; churn_rate: number | null; win_rate: number | null };
type RunResult = { ok: boolean; error?: string; scenario: string; counts: Record<string, number>;
                   customers: { email: string; name: string | null }[];
                   branches: { point_id: string; tree: string; branch: string; before: Stats; after: Stats }[] };
type ReportView = Omit<Validation, "events">;

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function targetClass(t: string): string {
  if (t.startsWith("refs.")) return "text-violet-300";
  if (t.startsWith("data.")) return "text-emerald-300";
  if (t.startsWith("actor.")) return "text-sky-300";
  return "text-zinc-200";
}

function CheckLine({ c }: { c: Check }) {
  const icon = c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✕";
  const cls = c.level === "ok" ? "text-emerald-400" : c.level === "warn" ? "text-amber-400" : "text-red-400";
  return (
    <li className="flex gap-2 text-xs">
      <span className={`w-3 font-bold ${cls}`}>{icon}</span>
      <span className="text-zinc-300">{c.message}
        {c.examples?.length ? <span className="text-zinc-500"> · {c.examples.join(", ")}</span> : null}</span>
    </li>
  );
}

export default function ConnectSource({ active, onClose, onChanged }: { active: boolean; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState("streamly-spring");
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [view, setView] = useState<string>("");            // a file name, "validate", or "result"
  const [report, setReport] = useState<ReportView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [graph, setGraph] = useState<{ email: string; nodes: ViewNode[]; rels: ViewRel[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    const out: Record<string, ParsedFile | string> = {};
    for (const f of files) {
      try { out[f.name] = parseFile(f.name, f.content); } catch (e) { out[f.name] = (e as Error).message; }
    }
    return out;
  }, [files]);

  const mappings = files.map((f) => proposals[f.name]?.mapping).filter((m): m is FileMapping => !!m);
  const allMapped = files.length > 0 && mappings.length === files.length;
  const mapping = view && proposals[view]?.mapping;
  const pf = parsed[view];

  function reset(next: { name: string; content: string }[]) {
    setFiles(next); setProposals({}); setReport(null); setResult(null); setGraph(null); setError(null);
    setView(next[0]?.name ?? "");
  }

  async function useSamples() {
    setBusy("files");
    const next = await Promise.all(SAMPLE_FILES.map(async (n) => ({ name: n, content: await (await fetch(`${SAMPLE_DIR}/${n}`)).text() })));
    setName("streamly-spring");
    reset(next);
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
                                                       body: JSON.stringify({ file: f }) });
      const data = await res.json();
      setProposals((p) => ({ ...p, [f.name]: res.ok ? { status: "done", mapping: data.mapping, seconds: data.seconds }
                                                    : { status: "error", error: data.error ?? res.statusText } }));
    }));
    setBusy(null);
  }

  function editField(file: string, recIdx: number, fieldIdx: number, change: Partial<FieldMap>) {
    setProposals((p) => {
      const m = structuredClone(p[file].mapping!);
      Object.assign(m.records[recIdx].fields[fieldIdx], change);
      return { ...p, [file]: { ...p[file], mapping: m, edited: true } };
    });
    setReport(null); setResult(null);
  }

  async function validateAll() {
    setBusy("validate"); setError(null);
    const res = await fetch("/api/upload/validate", { method: "POST", headers: { "content-type": "application/json" },
                                                      body: JSON.stringify({ name, files, mappings }) });
    const data = await res.json();
    if (res.ok) { setReport(data); setView("validate"); } else setError(data.error ?? res.statusText);
    setBusy(null);
  }

  async function runAll() {
    setBusy("run"); setError(null);
    const res = await fetch("/api/upload/run", { method: "POST", headers: { "content-type": "application/json" },
                                                 body: JSON.stringify({ name, files, mappings }) });
    const data = await res.json();
    if (res.ok) {
      setResult(data); setView("result"); onChanged();
      if (data.customers?.length) await showCustomer(data.customers[0].email);
    } else setError(data.error ?? res.statusText);
    setBusy(null);
  }

  async function removeBatch() {
    if (!result) return;
    setBusy("remove");
    await fetch(`/api/upload?scenario=${encodeURIComponent(result.scenario)}`, { method: "DELETE" });
    setResult(null); setGraph(null); setView("validate"); onChanged();
    setBusy(null);
  }

  async function showCustomer(email: string) {
    const res = await fetch(`/api/graph/customer?email=${encodeURIComponent(email)}`);
    if (res.ok) setGraph({ email, ...(await res.json()) });
  }

  const step = result ? 4 : report ? 3 : allMapped ? 2 : files.length ? 1 : 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex flex-wrap items-center gap-3 rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Connect a source</h2>
        <ol className="flex items-center gap-1 text-[11px]">
          {["Files", "Mapping (Claude)", "Validate + dry run", "Load into Neo4j"].map((s, i) => (
            <li key={s} className={`rounded-full px-2 py-0.5 ${step > i ? "bg-sky-700 text-white" : step === i ? "bg-zinc-700 text-zinc-100" : "text-zinc-500"}`}>
              {i + 1}. {s}</li>
          ))}
        </ol>
        <button onClick={onClose} className="ml-auto rounded-md bg-zinc-800 px-3 py-1 text-xs">Close</button>
      </header>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs">
        <button onClick={useSamples} disabled={!!busy} className="rounded-md bg-zinc-700 px-3 py-1 font-semibold disabled:opacity-40">
          {busy === "files" ? "Loading…" : "Use sample exports (6 files)"}</button>
        <label className="cursor-pointer rounded-md border border-zinc-700 px-3 py-1">
          Upload files…
          <input type="file" multiple accept=".csv,.jsonl,.ndjson" className="hidden" onChange={(e) => pickFiles(e.target.files)} />
        </label>
        <span className="text-zinc-500">batch</span>
        <input value={name} onChange={(e) => { setName(e.target.value); setReport(null); }}
               className="w-40 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono" />
        <span className="ml-auto flex gap-2">
          <button onClick={proposeAll} disabled={!files.length || !!busy}
                  className="rounded-md bg-sky-600 px-3 py-1 font-semibold text-white disabled:opacity-40">
            {busy === "propose" ? "Claude is mapping…" : allMapped ? "Re-map with Claude" : "Map with Claude"}</button>
          <button onClick={validateAll} disabled={!allMapped || !!busy}
                  className="rounded-md bg-amber-600 px-3 py-1 font-semibold text-white disabled:opacity-40">
            {busy === "validate" ? "Checking…" : "Validate + dry run"}</button>
          <button onClick={runAll} disabled={!report?.ok || !!busy}
                  className="rounded-md bg-emerald-600 px-3 py-1 font-semibold text-white disabled:opacity-40">
            {busy === "run" ? "Loading…" : "Approve + load into Neo4j"}</button>
        </span>
      </div>
      {error && <p className="border-b border-red-900 bg-red-950/50 px-4 py-1.5 text-xs text-red-300">{error}</p>}

      {!files.length ? (
        <div className="p-6 text-sm text-zinc-400">
          <p>Bring history in as the files a team already exports: ticket events, payments, the agent&apos;s tool-call log,
            fraud screening, subscriptions, usage. No pre-labelled decisions and no custom connector.</p>
          <p className="mt-2">Claude proposes how each file maps onto the event contract, with a reason per field. You review it,
            a deterministic validator checks it and dry-runs the detector, and only then is anything written.</p>
          <p className="mt-2 text-xs text-zinc-500">The sample exports are simulated Streamly data (16 new customers, spring 2026).
            Everything shown after mapping is computed live from the files.</p>
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
                    {typeof x === "string" ? "unreadable" : `${x.rows.length} rows`}
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
                <span className="text-sky-400">●</span> Loaded · {result.scenario}
              </button>
            )}
          </nav>

          {/* Detail */}
          <div className="min-h-0 overflow-y-auto p-4">
            {view === "validate" && report && <ValidationView report={report} />}
            {view === "result" && result && (
              <ResultView result={result} graph={graph} active={active} onCustomer={showCustomer} onRemove={removeBatch} busy={busy} />
            )}
            {view !== "validate" && view !== "result" && pf && (typeof pf === "string"
              ? <p className="text-sm text-red-400">Could not read {view}: {pf}</p>
              : mapping ? <MappingView file={pf} mapping={mapping} proposal={proposals[view]}
                                       onEdit={(r, i, c) => editField(view, r, i, c)} />
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
      <p className="font-mono text-sm">{file.name} <span className="text-xs text-zinc-500">· {file.format} · {file.rows.length} rows · {file.columns.length} columns</span></p>
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
function MappingView({ file, mapping, proposal, onEdit }: {
  file: ParsedFile; mapping: FileMapping; proposal: Proposal;
  onEdit: (record: number, field: number, change: Partial<FieldMap>) => void;
}) {
  const { events, problems } = useMemo(() => mapFile(file, mapping), [file, mapping]);
  const skipped = file.rows.filter((r) => !mapping.records.some((x) => matches(r, x.when)) && mapping.skipped.some((s) => matches(r, s.when))).length;
  const unmatched = file.rows.filter((r) => !mapping.records.some((x) => matches(r, x.when)) && !mapping.skipped.some((s) => matches(r, s.when))).length;
  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-sm">{file.name} <span className="text-xs text-zinc-500">· {file.format} · {file.rows.length} rows ·
          source <span className="text-zinc-300">{mapping.source}</span> · mapped by Claude in {proposal.seconds}s{proposal.edited ? " · edited by you" : ""}</span></p>
        <p className="mt-1 text-sm text-zinc-300">{mapping.reason}</p>
        <p className="mt-1 text-xs text-zinc-500">
          {events.length} rows → contract events{skipped ? ` · ${skipped} skipped on purpose` : ""}
          {unmatched ? <span className="text-amber-400"> · {unmatched} rows match no record type</span> : null}
          {problems.length ? <span className="text-red-400"> · {problems.length} values could not be converted</span> : null}
        </p>
      </div>
      {mapping.records.map((rec, ri) => (
        <RecordCard key={ri} file={file} rec={rec} count={events.filter((e) => e.record === rec.name).length}
                    example={events.find((e) => e.record === rec.name)} onEdit={(fi, c) => onEdit(ri, fi, c)} />
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

function RecordCard({ file, rec, count, example, onEdit }: {
  file: ParsedFile; rec: RecordMap; count: number; example?: ReturnType<typeof mapFile>["events"][number];
  onEdit: (field: number, change: Partial<FieldMap>) => void;
}) {
  const [showExample, setShowExample] = useState(false);
  const spec = DATA_FIELDS[rec.event_type];
  const mappedData = new Set(rec.fields.map((f) => f.target));
  const missingRequired = spec.required.filter((d) => !mappedData.has(`data.${d}`));
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
            <th className="px-3 py-1">Source column</th><th className="px-1 py-1" /><th className="px-2 py-1">Contract field</th>
            <th className="px-2 py-1">As</th><th className="px-2 py-1">Value translations</th><th className="px-2 py-1">Why</th>
          </tr>
        </thead>
        <tbody>
          {rec.fields.map((f, fi) => {
            const required = f.target.startsWith("data.") && spec.required.includes(f.target.slice(5));
            return (
              <tr key={fi} className="border-t border-zinc-900 align-top">
                <td className="px-3 py-1.5">
                  {f.column !== null ? (
                    <select value={f.column} onChange={(e) => onEdit(fi, { column: e.target.value })}
                            className={`max-w-52 rounded border bg-zinc-900 px-1 py-0.5 font-mono ${file.columns.includes(f.column) ? "border-zinc-700" : "border-red-600"}`}>
                      {!file.columns.includes(f.column) && <option value={f.column}>{f.column} (missing)</option>}
                      {file.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : f.template ? <span className="font-mono text-zinc-300">{f.template}</span>
                    : <span className="font-mono text-zinc-400">&quot;{f.value}&quot; <span className="text-zinc-600">constant</span></span>}
                </td>
                <td className="px-1 py-1.5 text-zinc-600">→</td>
                <td className={`whitespace-nowrap px-2 py-1.5 font-mono ${targetClass(f.target)}`}>{f.target}{required && <span className="text-amber-400" title="required"> *</span>}</td>
                <td className="px-2 py-1.5 text-zinc-500">{f.transform === "string" ? "" : f.transform}</td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {f.aliases.map((a) => (
                      <span key={a.from} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px]">
                        {a.from} <span className="text-zinc-500">→</span> <span className="text-emerald-300">{a.to}</span></span>
                    ))}
                    {f.otherwise && <span className="rounded border border-dashed border-zinc-700 px-1.5 py-0.5 text-[10px]">
                      otherwise <span className="text-emerald-300">{f.otherwise}</span></span>}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-zinc-400">{f.reason}</td>
              </tr>
            );
          })}
          {missingRequired.map((d) => (
            <tr key={d} className="border-t border-zinc-900">
              <td className="px-3 py-1.5 text-red-400">no column</td><td className="px-1 text-zinc-600">→</td>
              <td className="px-2 py-1.5 font-mono text-red-300">data.{d} *</td><td colSpan={3} className="px-2 text-red-400">required for {rec.event_type}</td>
            </tr>
          ))}
        </tbody>
      </table>
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

// ------------------------------------------------------------------ validator + dry run
function ValidationView({ report }: { report: ReportView }) {
  const d = report.dryRun;
  return (
    <div className="space-y-4">
      <p className={`rounded-md px-3 py-2 text-sm ${report.ok ? "bg-emerald-950 text-emerald-200" : "bg-red-950 text-red-200"}`}>
        {report.ok ? "All checks passed. Nothing has been written yet: approve to load." : "Fix the errors below (edit the mapping or re-map) before loading."}
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
          <ul className="space-y-1">{report.checks.map((c, i) => <CheckLine key={i} c={c} />)}</ul>
        </div>
      </div>
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
function ResultView({ result, graph, active, onCustomer, onRemove, busy }: {
  result: RunResult; graph: { email: string; nodes: ViewNode[]; rels: ViewRel[] } | null; active: boolean;
  onCustomer: (email: string) => void; onRemove: () => void; busy: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {   // Esc closes the expanded graph
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const customers = (
    <div className="flex flex-wrap gap-1">{result.customers.map((c) => (
      <button key={c.email} onClick={() => onCustomer(c.email)}
              className={`rounded border px-2 py-0.5 text-[11px] ${graph?.email === c.email ? "border-sky-600 bg-sky-950" : "border-zinc-700"}`}>
        {c.name ?? c.email}</button>
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
          Written to Neo4j as <span className="font-mono">{result.scenario}</span>: {result.counts.events} events,
          {" "}{result.counts.decisions} decisions, {result.counts.outcomes} outcomes, {result.counts.led_to} LED_TO links.</p>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">Customers ({result.customers.length})</p>
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
          {busy === "remove" ? "Removing…" : "Remove this batch"}</button>
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
