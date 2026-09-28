import { NextResponse, type NextRequest } from "next/server";

export const ACCESS_COOKIE = "rn_access";

// The demo spends API credit, so every page and API route needs the access code.
export function proxy(request: NextRequest) {
  const code = process.env.DEMO_ACCESS_CODE?.trim();
  if (code && request.cookies.get(ACCESS_COOKIE)?.value === code) return NextResponse.next();
  // MCP clients can't hold the browser cookie: they send the access code as a bearer token.
  if (code && request.headers.get("authorization") === `Bearer ${code}`) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return Response.json({ error: "access code required" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!login|api/login|api/health|_next/static|_next/image|favicon.ico).*)"],
};
