"use client";
// "Delete scenario": pick one of the scenarios this app may delete, type its name, delete (demo spec §22).
import { useEffect, useState } from "react";

type Info = { scenario: string; kind: string; events: number; decisions: number };

export default function DeleteScenario({ onDeleted, refreshKey = 0 }: { onDeleted?: () => void; refreshKey?: number }) {
  const [list, setList] = useState<Info[]>([]);
  const [picked, setPicked] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const apply = (l: Info[]) => { setList(l); setPicked((p) => (l.some((x) => x.scenario === p) ? p : l[0]?.scenario ?? "")); };
  useEffect(() => { fetch("/api/scenarios").then((r) => r.json()).then(apply).catch(() => {}); }, [refreshKey]);

  async function remove() {
    setBusy(true); setMessage(null);
    const res = await fetch("/api/scenarios", { method: "DELETE", headers: { "content-type": "application/json" },
                                                body: JSON.stringify({ scenario: picked, confirm }) });
    const data = await res.json();
    setMessage(res.ok ? `✓ Deleted ${picked}.` : `✕ ${data.error ?? res.statusText}`);
    setConfirm(""); setBusy(false);
    apply(await (await fetch("/api/scenarios")).json());
    if (res.ok) onDeleted?.();
  }

  const info = list.find((x) => x.scenario === picked);
  return (
    <div className="space-y-2 rounded-md border border-red-900/60 p-3 text-xs">
      <p className="font-semibold text-red-300">Delete a scenario</p>
      {!list.length ? <p className="text-zinc-500">Nothing loaded that this app can delete.</p> : <>
        <select value={picked} onChange={(e) => { setPicked(e.target.value); setConfirm(""); setMessage(null); }}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1">
          {list.map((x) => <option key={x.scenario} value={x.scenario}>{x.scenario} · {x.kind}</option>)}
        </select>
        {info && <p className="text-zinc-400">{info.events.toLocaleString()} events · {info.decisions.toLocaleString()} decisions will be
          deleted{info.kind.startsWith("loaded history") ? ", with its decision trees, analytics and load batches (settings stay)"
            : info.scenario === "everything" ? ": every loaded set, upload batch and live decision; the history and prepared customers stay" : ""}.
          Can&apos;t be undone; data from a source can be loaded again.</p>}
        <div className="flex gap-2">
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`type ${picked} to confirm`}
                 className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1" />
          <button onClick={remove} disabled={busy || !picked || confirm !== picked}
                  className="rounded bg-red-600 px-3 py-1 font-semibold text-white disabled:opacity-40">{busy ? "Deleting…" : "Delete"}</button>
        </div>
      </>}
      {message && <p className={message.startsWith("✓") ? "text-emerald-400" : "text-red-400"}>{message}</p>}
    </div>
  );
}
