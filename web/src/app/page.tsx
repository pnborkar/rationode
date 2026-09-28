"use client";

// Milestone 6 test console: run the live support agent with the graph on or off.
// The four-panel demo screen (demo spec Section 10.1) replaces this in milestone 7.
import { useState } from "react";

type Event = { type: string; [key: string]: unknown };

const SAM = {
  customer_email: "sam.okafor26002@example.com",
  message: "Hi, I was charged $180 for my annual renewal but I haven't used Streamly at all this year. Can I get a refund?",
};

export default function Console() {
  const [graph, setGraph] = useState(true);
  const [message, setMessage] = useState(SAM.message);
  const [events, setEvents] = useState<Event[]>([]);
  const [thinking, setThinking] = useState("");
  const [reply, setReply] = useState("");
  const [running, setRunning] = useState(false);

  async function run() {
    setEvents([]); setThinking(""); setReply(""); setRunning(true);
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket_id: "500001", customer_email: SAM.customer_email, channel: "chat", message, graph }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        const e = JSON.parse(part.slice(6)) as Event;
        if (e.type === "thinking") setThinking((t) => t + (e.text as string));
        else if (e.type === "text") setReply((r) => r + (e.text as string));
        else setEvents((all) => [...all, e]);
      }
    }
    setRunning(false);
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8 text-zinc-100">
      <h1 className="text-2xl font-semibold">Rationode — agent console</h1>
      <div className="space-y-3 rounded-xl border border-zinc-800 p-4">
        <p className="text-sm text-zinc-400">Streamly help chat · Sam Okafor ({SAM.customer_email})</p>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-3" />
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={graph} onChange={(e) => setGraph(e.target.checked)} />
            Decision graph {graph ? "ON" : "OFF"}
          </label>
          <button onClick={run} disabled={running}
                  className="rounded-md bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50">
            {running ? "Agent working…" : "Send to agent"}
          </button>
        </div>
      </div>

      {thinking && (
        <section className="rounded-xl border border-zinc-800 p-4">
          <h2 className="mb-2 text-sm font-semibold text-zinc-400">Agent&apos;s thinking</h2>
          <p className="whitespace-pre-wrap text-sm text-zinc-300">{thinking}</p>
        </section>
      )}

      <section className="space-y-2">
        {events.map((e, i) => (
          <pre key={i} className={`overflow-x-auto rounded-lg p-3 text-xs ${
            e.type === "proposal" ? "border border-emerald-600 bg-emerald-950" :
            e.type === "error" ? "bg-red-950" : "bg-zinc-900"}`}>
            {e.type.toUpperCase()} {JSON.stringify(e.type === "tool_result" ? e.result : e, null, 2).slice(0, 2500)}
          </pre>
        ))}
      </section>

      {reply && (
        <section className="rounded-xl border border-zinc-800 p-4">
          <h2 className="mb-2 text-sm font-semibold text-zinc-400">Reply to Sam</h2>
          <p>{reply}</p>
        </section>
      )}
    </main>
  );
}
