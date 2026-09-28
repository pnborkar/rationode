"use client";

import type NVL from "@neo4j-nvl/base";
import type { Node, Relationship } from "@neo4j-nvl/base";
import { InteractiveNvlWrapper } from "@neo4j-nvl/react";
import { useEffect, useMemo, useRef } from "react";
import type { GraphNode, GraphRel } from "@/lib/caseGraph";

export type ViewNode = GraphNode & { live?: boolean };
export type ViewRel = GraphRel;

// Colors: decisions by outcome, so the precedent reads at a glance.
const KIND_COLOR: Record<string, string> = {
  customer: "#a78bfa", charge: "#64748b", ticket: "#64748b", dispute: "#64748b", subscription: "#64748b",
  outcome: "#f87171", case: "#fbbf24", proposal: "#38bdf8", final: "#34d399",
  signals: "#f59e0b", rule: "#94a3b8", policy: "#0ea5e9", pattern: "#dc2626",
  usage: "#14b8a6",
};

export function decisionColor(outcomes: string[] = []): string {
  if (outcomes.includes("dispute_filed") || outcomes.includes("dispute_lost")) return "#ef4444";
  if (outcomes.includes("churn")) return "#f59e0b";
  return "#22c55e";
}

function toNvl(n: ViewNode): Node {
  const isDecision = n.kind === "decision" || n.kind === "precedent";
  const caption = n.kind === "precedent" ? (n.option ?? "").replaceAll("_", " ")
    : isDecision ? `${n.label}\n${(n.option ?? "").replaceAll("_", " ")}` : n.label;
  return {
    id: n.id,
    caption,
    color: isDecision ? decisionColor(n.outcomes)
      : n.kind === "outcome" ? (n.label === "Renewed" || n.label === "Dispute won" ? "#22c55e"
          : n.label.startsWith("Refunded") ? "#f59e0b" : "#f87171")
      : (KIND_COLOR[n.kind] ?? "#94a3b8"),
    size: n.kind === "customer" ? 38 : n.kind === "proposal" || n.kind === "final" ? 54 : n.kind === "case" ? 34
      : n.kind === "precedent" ? 28 : 28,
    captionSize: 3,
    selected: n.live,
  };
}

export default function GraphView({ nodes, rels }: { nodes: ViewNode[]; rels: ViewRel[] }) {
  const nvlNodes = useMemo(() => nodes.map(toNvl), [nodes]);
  const nvlRels = useMemo<Relationship[]>(() => rels.map((r) => ({
    id: r.id, from: r.from, to: r.to, caption: r.type,
    color: r.type === "OVERRIDES" || r.type === "POLICY_GAP" || r.type === "CONTRADICTS" ? "#f87171" : r.type === "SIMILAR_TO" ? "#334155" : "#64748b",
    width: r.type === "SIMILAR_TO" || r.type === "INCLUDES" ? 1 : r.type === "POLICY_GAP" || r.type === "CONTRADICTS" ? 4 : 2,
  })), [rels]);

  // Keep everything in view as live nodes arrive.
  const nvl = useRef<NVL>(null);
  useEffect(() => {
    const timer = setTimeout(() => nvl.current?.fit(nvlNodes.map((n) => n.id)), 900);
    return () => clearTimeout(timer);
  }, [nvlNodes]);

  return (
    <InteractiveNvlWrapper
      ref={nvl}
      nodes={nvlNodes}
      rels={nvlRels}
      nvlOptions={{ layout: "forceDirected", initialZoom: 0.9, renderer: "canvas", disableTelemetry: true }}
      mouseEventCallbacks={{ onZoomAndPan: true, onPan: true, onDrag: true }}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
