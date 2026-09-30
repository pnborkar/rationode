import { NextResponse } from "next/server";
import { ACCESS_COOKIE } from "@/proxy";
import { withTenant } from "@/lib/tenant";

async function POST_(request: Request) {
  const form = await request.formData();
  const code = String(form.get("code") ?? "").trim();
  const expected = process.env.DEMO_ACCESS_CODE?.trim();
  const ok = Boolean(expected) && code === expected;
  const response = NextResponse.redirect(new URL(ok ? "/" : "/login?error=1", request.url), 303);
  if (ok) {
    response.cookies.set(ACCESS_COOKIE, code, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 12,
    });
  }
  return response;
}

// Every request runs in its workspace (demo spec §23.9).
export const POST = withTenant(POST_);
