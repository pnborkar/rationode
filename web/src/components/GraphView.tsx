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
    color: isDecision ? decisionColor(n.outcomes) : (KIND_COLOR[n.kind] ?? "#94a3b8"),
    size: n.kind === "customer" ? 38 : n.kind === "case" || n.kind === "proposal" || n.kind === "final" ? 32
      : n.kind === "precedent" ? 18 : 24,
    captionSize: n.kind === "precedent" ? 2 : 3,
    selected: n.live,
  };
}

export default function GraphView({ nodes, rels }: { nodes: ViewNode[]; rels: ViewRel[] }) {
  const nvlNodes = useMemo(() => nodes.map(toNvl), [nodes]);
  const nvlRels = useMemo<Relationship[]>(() => rels.map((r) => ({
    id: r.id, from: r.from, to: r.to, caption: r.type,
    color: r.type === "OVERRIDES" ? "#f87171" : r.type === "SIMILAR_TO" ? "#334155" : "#64748b",
    width: r.type === "SIMILAR_TO" ? 1 : 2,
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
