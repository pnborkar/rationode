import { NextResponse } from "next/server";
import { ACCESS_COOKIE } from "@/proxy";
import { accessFor, workspacePath } from "@/lib/workspaces";

// The master code opens every workspace; a workspace's own code opens only it (demo spec §23.9). After signing in,
// go where the person was headed if the code opens it, else to the code's workspace.
export async function POST(request: Request) {
  const form = await request.formData();
  const code = String(form.get("code") ?? "").trim();
  const next = String(form.get("next") ?? "");
  const access = accessFor(code);
  const nextWorkspace = next.split("/")[1] ?? "";
  const target = !access ? `/login?error=1${next ? `&next=${encodeURIComponent(next)}` : ""}`
    : next.startsWith("/") && !next.startsWith("//") && (access === "all" || nextWorkspace === access) ? next
    : access === "all" ? "/" : workspacePath(access);
  const response = NextResponse.redirect(new URL(target, request.url), 303);
  if (access) {
    response.cookies.set(ACCESS_COOKIE, code, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 12,
    });
  }
  return response;
}
