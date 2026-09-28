"use client";

import { decisionColor, type ViewNode, type ViewRel } from "./GraphView";

// The same nodes as the graph view, as a table: what each node is, what was decided, what followed.
const KIND_LABEL: Record<string, string> = {
  customer: "Customer", charge: "Charge", ticket: "Ticket", dispute: "Dispute", subscription: "Subscription",
  decision: "Decision (history)", outcome: "Outcome", case: "New case", precedent: "Similar past decision",
  proposal: "AI proposal (live)", final: "Rep decision (live)",
  signals: "Fraud signals", rule: "Fraud rule", policy: "Written policy", pattern: "Same policy gap",
};
const ORDER = ["customer", "charge", "ticket", "dispute", "subscription", "decision", "signals", "rule", "policy",
               "outcome", "case", "pattern", "precedent", "proposal", "final"];

const words = (s: string) => s.replaceAll("_", " ");

function outcomeText(n: ViewNode): string {
  if (n.kind !== "decision" && n.kind !== "precedent") return "";
  if (!n.outcomes?.length) return "no outcome recorded";
  return [...new Set(n.outcomes)].map(words).join(", ");
}

export default function GraphTable({ nodes, rels }: { nodes: ViewNode[]; rels: ViewRel[] }) {
  const rows = [...nodes].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const degree = (id: string) => rels.filter((r) => r.from === id || r.to === id).length;
  return (
    <div className="h-full overflow-auto">
      <p className="px-4 pb-2 text-xs text-zinc-500">{nodes.length} nodes · {rels.length} relationships</p>
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-2 py-2 font-medium">Node</th>
            <th className="px-2 py-2 font-medium">Decided</th>
            <th className="px-2 py-2 font-medium">What followed</th>
            <th className="px-2 py-2 font-medium">Detail</th>
            <th className="px-4 py-2 text-right font-medium">Links</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const isDecision = n.kind === "decision" || n.kind === "precedent";
            return (
              <tr key={n.id} className={`border-t border-zinc-800 ${n.live ? "bg-sky-950/30" : ""}`}>
                <td className="px-4 py-1.5 text-zinc-400">{KIND_LABEL[n.kind] ?? n.kind}</td>
                <td className="px-2 py-1.5">{n.label.replaceAll("\n", " · ")}</td>
                <td className="px-2 py-1.5">{n.option ? words(n.option) : ""}</td>
                <td className="px-2 py-1.5">
                  {isDecision && (
                    <span className="flex items-center gap-2">
                      <i className="inline-block h-2 w-2 rounded-full" style={{ background: decisionColor(n.outcomes) }} />
                      {outcomeText(n)}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-zinc-400">{n.detail ?? ""}</td>
                <td className="px-4 py-1.5 text-right text-zinc-500">{degree(n.id)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
