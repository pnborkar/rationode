"use client";
// Settings → Decision model (demo spec §22.1, first slice): the outcome window (a workspace default, overrides per
// outcome type) and good / bad per outcome type. Defaults are named and left alone; a change is previewed (what it
// would credit differently) before it's saved, and every change is recorded.
import { useEffect, useState } from "react";

type Model = { defaultWindow: number; windows: Record<string, number>; polarities: Record<string, "good" | "bad"> };
type TypeRow = { type: string; n: number; credited: number; outside: number; polarities: (string | null)[] };
type Change = { key: string; from: string; to: string; by: string; at: string };
type Counts = { n: number; credited: number; outside: number; bad: number };
type Preview = { types: { type: string; now?: Counts; after?: Counts }[] } | { error: string };

const input = "rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono";

export default function DecisionModel() {
  const [data, setData] = useState<{ available: boolean; model: Model; types: TypeRow[]; history: Change[] } | null>(null);
  const [draft, setDraft] = useState<Model | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = () => fetch("/api/settings/model").then((r) => r.json()).then((d) => { setData(d); setDraft(d.model ?? null); setPreview(null); });
  useEffect(() => { load(); }, []);

  if (!data) return <p className="text-xs text-zinc-500">Loading…</p>;
  if (!data.available || !draft) return <p className="text-xs text-zinc-500">The demo&apos;s decision model comes from its pipeline and isn&apos;t configurable here.</p>;
  const changed = JSON.stringify(draft) !== JSON.stringify(data.model);
  const fromData = (r: TypeRow) => (r.polarities.filter(Boolean).join(" / ") || "not set");

  async function post(action: "preview" | "apply") {
    setBusy(action); setMessage(null);
    const res = await fetch("/api/settings/model", { method: "POST", headers: { "content-type": "application/json" },
                                                    body: JSON.stringify({ action, model: draft }) });
    const body = await res.json();
    setBusy(null);
    if (!res.ok || body.error) { setMessage(`✕ ${body.error ?? res.statusText}`); return; }
    if (action === "preview") setPreview(body);
    else { setMessage(`✓ Saved ${body.changes.length} change(s)${body.reprocessed ? " and re-processed the workspace" : ""}.`); await load(); }
  }

  const setWindow = (t: string, v: string) => {
    const w = { ...draft.windows };
    if (!v || Number(v) === draft.defaultWindow) delete w[t]; else w[t] = Math.max(1, Math.min(3650, Number(v)));
    setDraft({ ...draft, windows: w }); setPreview(null);
  };
  const setPolarity = (t: string, v: string) => {
    const p = { ...draft.polarities };
    if (!v) delete p[t]; else p[t] = v as "good" | "bad";
    setDraft({ ...draft, polarities: p }); setPreview(null);
  };

  return (
    <div className="space-y-3 text-xs">
      <p className="text-zinc-500">How this workspace reads its outcomes. Defaults apply unless you change them; a change is previewed before
        it&apos;s saved, re-processes the workspace, and is recorded below.</p>
      <label className="flex items-center gap-2">
        <span className="text-zinc-300">Outcome window (default for every outcome type)</span>
        <input type="number" min={1} max={3650} value={draft.defaultWindow} className={`${input} w-20`}
               onChange={(e) => { setDraft({ ...draft, defaultWindow: Math.max(1, Math.min(3650, Number(e.target.value) || 1)) }); setPreview(null); }} />
        <span className="text-zinc-500">days after a decision: how long an outcome is still credited to it when its subject had several
          decisions (with a single decision it&apos;s credited whatever the delay)</span>
      </label>
      {data.types.length === 0 ? <p className="text-zinc-500">No outcomes loaded yet.</p> : (
        <table className="w-full">
          <thead><tr className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
            <th className="py-1">Outcome type</th><th>Outcomes</th><th>Credited to a decision</th><th>Good / bad</th><th>Window</th>
          </tr></thead>
          <tbody>{data.types.map((r) => (
            <tr key={r.type} className="border-t border-zinc-800">
              <td className="py-1.5 font-mono text-zinc-200">{r.type}</td>
              <td>{r.n.toLocaleString()}</td>
              <td className={r.credited < r.n ? "text-amber-300" : ""}>{r.credited.toLocaleString()}
                {r.outside > 0 && <span className="text-zinc-500"> ({r.outside} outside the window)</span>}
                {r.credited < r.n && <span className="text-zinc-500"> · {(r.n - r.credited).toLocaleString()} credited to none</span>}</td>
              <td>
                <select value={draft.polarities[r.type] ?? ""} onChange={(e) => setPolarity(r.type, e.target.value)} className={input}>
                  <option value="">from the data ({fromData(r)})</option><option value="good">good</option><option value="bad">bad</option>
                </select>
              </td>
              <td className="whitespace-nowrap">
                <input type="number" min={1} max={3650} placeholder={`${draft.defaultWindow}`} value={draft.windows[r.type] ?? ""}
                       onChange={(e) => setWindow(r.type, e.target.value)} className={`${input} w-20`} />
                <span className="ml-1 text-zinc-500">{draft.windows[r.type] ? "days" : "default"}</span>
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={!changed || !!busy} onClick={() => post("preview")} className="rounded bg-sky-600 px-3 py-0.5 font-semibold text-white disabled:opacity-40">
          {busy === "preview" ? "Working it out…" : "Preview the effect"}</button>
        <button disabled={!changed || !preview || "error" in (preview ?? {}) || !!busy}
                onClick={() => { if (window.confirm("Save these settings and re-process the workspace with them?")) post("apply"); }}
                className="rounded bg-emerald-600 px-3 py-0.5 font-semibold text-white disabled:opacity-40"
                title={!preview ? "Preview the effect first" : undefined}>{busy === "apply" ? "Saving and re-processing…" : "Save and re-process"}</button>
        {changed && <button disabled={!!busy} onClick={() => { setDraft(data.model); setPreview(null); }} className="rounded bg-zinc-800 px-3 py-0.5">Undo changes</button>}
        {message && <span className={message.startsWith("✓") ? "text-emerald-400" : "text-red-400"}>{message}</span>}
      </div>
      {preview && ("error" in preview ? <p className="text-red-400">{preview.error}</p> : (
        <div className="rounded-md border border-sky-900 bg-sky-950/30 p-2">
          <p className="mb-1 font-semibold text-sky-200">If saved (nothing written yet):</p>
          <ul className="space-y-0.5">{preview.types.map(({ type, now: fresh, after }) => {
            // Compare with what the table shows (the graph as stored), so pending re-processing shows up too.
            const stored = data.types.find((t) => t.type === type);
            const now = stored && fresh ? { ...fresh, credited: stored.credited, outside: stored.outside } : fresh;
            const lines = [
              now && after && now.credited !== after.credited ? `credited ${now.credited} → ${after.credited} of ${after.n}` : null,
              now && after && now.outside !== after.outside ? `outside the window ${now.outside} → ${after.outside}` : null,
              now && after && now.bad !== after.bad ? `bad ${now.bad} → ${after.bad}` : null,
            ].filter(Boolean);
            return <li key={type}><span className="font-mono">{type}</span>: <span className="text-zinc-300">{lines.length ? lines.join(" · ") : "no change"}</span></li>;
          })}</ul>
        </div>
      ))}
      {data.history.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Changes</p>
          <ul className="space-y-0.5 text-zinc-400">{data.history.map((c, i) => (
            <li key={i}>{c.at.slice(0, 16).replace("T", " ")} · {c.key}: {c.from} → <span className="text-zinc-200">{c.to}</span> <span className="text-zinc-600">({c.by})</span></li>
          ))}</ul>
        </div>
      )}
    </div>
  );
}
