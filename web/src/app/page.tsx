"use client";
// The app renders in the browser only: its workspace (§23.9) is known there (set by the layout per request), so the
// server never pre-renders one workspace's page for another.
import dynamic from "next/dynamic";

const RationodeApp = dynamic(() => import("@/components/RationodeApp"), { ssr: false });

export default function Page() {
  return <RationodeApp />;
}
