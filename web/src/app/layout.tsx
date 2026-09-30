import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { DEFAULT_TENANT, isWorkspace, workspaces } from "@/lib/tenant";
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
  // The page's workspace (§23.9): the rn_tenant cookie if it names an allowed workspace, else the default.
  const chosen = (await cookies()).get("rn_tenant")?.value;
  const tenant = isWorkspace(chosen) ? chosen : DEFAULT_TENANT;
  const workspaceScript = `window.__RN_TENANT__=${JSON.stringify(tenant)};window.__RN_WORKSPACES__=${JSON.stringify(workspaces())};`;
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
