"use client";

import { useSyncExternalStore } from "react";

// Dark is the default; "light" is a class on <html> (see globals.css) remembered in localStorage.
const EVENT = "rn-theme-change";

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}
const isLight = () => document.documentElement.classList.contains("light");

export default function ThemeToggle() {
  const light = useSyncExternalStore(subscribe, isLight, () => false);

  function toggle() {
    const next = !isLight();
    document.documentElement.classList.toggle("light", next);
    try { localStorage.setItem("rn-theme", next ? "light" : "dark"); } catch {}
    window.dispatchEvent(new Event(EVENT));
  }

  return (
    <button onClick={toggle} title={light ? "Switch to dark mode" : "Switch to light mode"}
            className="rounded-full bg-white/15 px-3 py-1.5 text-sm text-white hover:bg-white/25">
      {light ? "☾ Dark" : "☀ Light"}
    </button>
  );
}
