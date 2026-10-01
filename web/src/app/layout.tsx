import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";
import { refreshWorkspaces } from "@/lib/workspaceRegistry";
import { accessFor, DEFAULT_TENANT, isWorkspace, visibleWorkspaces } from "@/lib/workspaces";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Rationode",
  description: "Every decision from AI, humans, and systems, in one Neo4j graph",
};

// Apply the saved theme before first paint (no dark flash for light-mode users).
const THEME_SCRIPT = `try{if(localStorage.getItem("rn-theme")==="light")document.documentElement.classList.add("light")}catch(e){}`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The page's workspace (§23.9): resolved from the path by the proxy; the dropdown lists the workspaces this access
  // code opens (all for the master code, one for a workspace's own code).
  await refreshWorkspaces();
  const chosen = (await headers()).get("x-rationode-tenant");
  const tenant = isWorkspace(chosen) ? chosen : DEFAULT_TENANT;
  const access = accessFor((await cookies()).get("rn_access")?.value);
  const workspaceScript = `window.__RN_TENANT__=${JSON.stringify(tenant)};window.__RN_DEFAULT__=${JSON.stringify(DEFAULT_TENANT)};` +
    `window.__RN_WORKSPACES__=${JSON.stringify(visibleWorkspaces(access))};`;
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: workspaceScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
