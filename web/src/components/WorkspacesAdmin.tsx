"use client";
// Settings → Workspaces (demo spec §23.9): the workspaces this deployment serves. Those from the configuration
// (RATIONODE_WORKSPACES) are fixed here; new ones can be added (appended to the list, no redeploy) and removed again.
// Only shown to the master access code.
import { useEffect, useState } from "react";
import { workspaceHref } from "@/lib/workspace";

type Row = { id: string; name: string; from: "configuration" | "settings"; decisions: number };
const input = "rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5";

export default function WorkspacesAdmin() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => fetch("/api/workspaces").then((r) => (r.ok ? r.json() : null)).then(setRows).catch(() => setRows(null));
  useEffect(() => { load(); }, []);
  if (!rows) return null;   // not the master code: nothing to show

  async function add() {
    setBusy(true); setMessage(null);
    const res = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name }) });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) { setMessage(`✕ ${body.error}`); return; }
    setMessage(`✓ Added "${body.id}": open it at ${workspaceHref(body.id)} (it may take up to 30 seconds everywhere).`);
    setId(""); setName(""); load();
  }
  async function remove(w: Row) {
    if (!window.confirm(`Take "${w.id}" off the list? Its data stays in Neo4j (delete it first from its own Settings if you want it gone); adding "${w.id}" again brings it back.`)) return;
    const res = await fetch(`/api/workspaces?id=${encodeURIComponent(w.id)}`, { method: "DELETE" });
    const body = await res.json();
    setMessage(res.ok ? `✓ Removed "${w.id}" from the list.` : `✕ ${body.error}`);
    load();
  }

  return (
    <div className="space-y-2 text-xs">
      <p className="text-zinc-500">The workspaces this deployment serves, each at its own address. Those from the configuration
        (RATIONODE_WORKSPACES) are fixed here; ones added here are appended to that list. Give a company its own code with
        RATIONODE_WORKSPACE_CODES. Only the master access code sees this.</p>
      <table className="w-full">
        <thead><tr className="text-left text-[10px] uppercase tracking-wide text-zinc-500"><th className="py-1">ID</th><th>Name</th><th>Decisions</th><th>From</th><th /></tr></thead>
        <tbody>{rows.map((w) => (
          <tr key={w.id} className="border-t border-zinc-800">
            <td className="py-1.5 font-mono"><a href={workspaceHref(w.id)} className="text-sky-300 hover:underline">{w.id}</a></td>
            <td>{w.name}</td><td>{w.decisions.toLocaleString()}</td>
            <td className="text-zinc-500">{w.from === "configuration" ? "configuration" : "added in Settings"}</td>
            <td className="text-right">{w.from === "settings" && <button onClick={() => remove(w)} className="rounded bg-zinc-800 px-2 py-0.5">Remove</button>}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-400">Add a workspace</span>
        <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="id, e.g. acme" className={`${input} w-32 font-mono`} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name, e.g. Acme Bank" className={`${input} w-48`} />
        <button onClick={add} disabled={!id.trim() || busy} className="rounded bg-emerald-600 px-3 py-0.5 font-semibold text-white disabled:opacity-40">Add</button>
        <span className="text-zinc-500">The ID is the address (/{id || "acme"}) and the data&apos;s key: pick it once, don&apos;t change it.</span>
      </div>
      {message && <p className={message.startsWith("✓") ? "text-emerald-400" : "text-red-400"}>{message}</p>}
    </div>
  );
}
