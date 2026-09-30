"use client";
// The Ask tab (demo spec §23.8, option B): questions in plain English about this workspace's decisions, answered by
// Claude from the graph (the tool steps are shown, so every number can be traced). Works for any domain.
import { useRef, useState, type ReactNode } from "react";

type Step = { kind: "note" | "tool"; text: string; detail?: string; error?: boolean };
type Turn = { question: string; answer: string; steps: Step[]; thinking: string; done: boolean; error?: string };

const SUGGESTED = [
  "What decisions are recorded here, and how do they usually end?",
  "What makes the difference between good and bad outcomes?",
  "Which decisions look risky: where do bad outcomes cluster?",
  "Tell me the story of one recent case, from decision to outcome.",
];

// A tiny renderer for the answers: paragraphs, "- " bullets, **bold**, *italic*, `code` and | tables |.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith("**") ? <b key={i}>{part.slice(2, -2)}</b>
      : part.startsWith("`") ? <code key={i} className="rounded bg-zinc-800 px-1 text-[0.9em]">{part.slice(1, -1)}</code>
      : part.startsWith("*") && part.endsWith("*") && part.length > 2 ? <i key={i}>{part.slice(1, -1)}</i> : part);
}
function Rendered({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);   // skip the |---| separator
        i++;
      }
      i--;
      out.push(
        <table key={i} className="my-2 border-collapse text-xs">
          <tbody>{rows.map((r, ri) => (
            <tr key={ri} className={ri === 0 ? "font-semibold text-zinc-300" : ""}>
              {r.map((c, ci) => <td key={ci} className="border border-zinc-800 px-2 py-1">{inline(c)}</td>)}</tr>
          ))}</tbody>
        </table>);
    } else if (/^\s*[-•]\s+/.test(line)) {
      out.push(<p key={i} className="ml-3 -indent-3">• {inline(line.replace(/^\s*[-•]\s+/, ""))}</p>);
    } else if (line.trim()) {
      out.push(<p key={i} className="my-1">{inline(line)}</p>);
    }
  }
  return <div className="space-y-0.5">{out}</div>;
}

export default function AskTab() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [openSteps, setOpenSteps] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  async function send(q: string) {
    if (!q.trim() || busy) return;
    const history = turns.filter((t) => t.done && t.answer).flatMap((t) => [
      { role: "user" as const, content: t.question }, { role: "assistant" as const, content: t.answer }]);
    const index = turns.length;
    setTurns((ts) => [...ts, { question: q, answer: "", steps: [], thinking: "", done: false }]);
    setQuestion(""); setBusy(true);
    const update = (f: (t: Turn) => Turn) => setTurns((ts) => ts.map((t, i) => (i === index ? f(t) : t)));
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" },
                                            body: JSON.stringify({ question: q, history }) });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          const e = JSON.parse(p.slice(6));
          if (e.type === "text") update((t) => ({ ...t, answer: t.answer + e.text }));
          else if (e.type === "thinking") update((t) => ({ ...t, thinking: t.thinking + e.text }));
          else if (e.type === "tool_call") {
            // Text before a tool call is the assistant narrating its next step, not the answer.
            update((t) => ({ ...t, answer: "", steps: [...t.steps, ...(t.answer.trim() ? [{ kind: "note" as const, text: t.answer.trim() }] : []),
              { kind: "tool" as const, text: e.name.replaceAll("_", " "), detail: JSON.stringify(e.input) }] }));
          } else if (e.type === "tool_result") {
            update((t) => ({ ...t, steps: t.steps.map((s, i) => (i === t.steps.length - 1 && s.kind === "tool"
              ? { ...s, text: `${s.text} → ${e.summary} (${e.ms} ms)`, error: e.is_error } : s)) }));
          } else if (e.type === "error") update((t) => ({ ...t, error: e.message }));
        }
        endRef.current?.scrollIntoView({ block: "end" });
      }
    } catch (err) {
      update((t) => ({ ...t, error: (err as Error).message }));
    }
    update((t) => ({ ...t, done: true }));
    setBusy(false);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex items-center gap-3 rounded-t-xl border-b border-zinc-800 bg-zinc-800/70 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Ask</h2>
        <span className="text-xs text-zinc-500">questions about the decisions in this workspace, answered from the graph</span>
        {turns.length > 0 && <button onClick={() => setTurns([])} disabled={busy} className="ml-auto rounded-md bg-zinc-800 px-3 py-1 text-xs disabled:opacity-40">New conversation</button>}
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {!turns.length && (
          <div className="mx-auto max-w-2xl space-y-2 pt-6 text-sm">
            <p className="text-zinc-400">Ask anything about the decisions recorded here: what was decided, by whom, based on what, and how it turned out. Every number comes from the graph, and the steps behind each answer are shown.</p>
            <div className="flex flex-wrap gap-2 pt-2">
              {SUGGESTED.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800">{s}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="mx-auto max-w-4xl space-y-2">
            <p className="ml-auto w-fit max-w-[80%] rounded-2xl bg-violet-600 px-4 py-2 text-sm text-white">{t.question}</p>
            {t.steps.length > 0 && (
              <div className="text-xs text-zinc-500">
                <button onClick={() => setOpenSteps(openSteps === i ? null : i)} className="hover:text-zinc-300">
                  {openSteps === i ? "▾" : "▸"} {t.steps.filter((s) => s.kind === "tool").length} step{t.steps.filter((s) => s.kind === "tool").length === 1 ? "" : "s"} in the graph{!t.done ? "…" : ""}</button>
                {openSteps === i && (
                  <ul className="mt-1 space-y-0.5 border-l border-zinc-800 pl-3">
                    {t.steps.map((s, j) => (
                      <li key={j} className={s.error ? "text-red-400" : s.kind === "note" ? "italic" : ""} title={s.detail}>{s.text}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="rounded-2xl bg-zinc-800/60 px-4 py-3 text-sm text-zinc-100">
              {t.answer ? <Rendered text={t.answer} />
                : t.error ? null : <span className="text-zinc-500">{t.steps.length ? "Looking in the graph…" : "Thinking…"}</span>}
              {t.error && <p className="text-red-400">{t.error}</p>}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 border-t border-zinc-800 p-3">
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} disabled={busy}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(question); } }}
                  placeholder="Ask about the decisions here… (Enter to send)"
                  className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm" />
        <button onClick={() => send(question)} disabled={busy || !question.trim()}
                className="rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "…" : "Ask"}</button>
      </div>
    </section>
  );
}
