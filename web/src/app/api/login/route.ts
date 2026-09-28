import { NextResponse } from "next/server";
import { ACCESS_COOKIE } from "@/proxy";

export async function POST(request: Request) {
  const form = await request.formData();
  const ok = form.get("code") === process.env.DEMO_ACCESS_CODE;
  const response = NextResponse.redirect(new URL(ok ? "/" : "/login?error=1", request.url), 303);
  if (ok) {
    response.cookies.set(ACCESS_COOKIE, String(form.get("code")), {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 12,
    });
  }
  return response;
}
