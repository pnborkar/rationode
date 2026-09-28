// Which settings this deployment has (never their values), for checking a Vercel deploy.
export function GET() {
  const set = (name: string) => Boolean(process.env[name]?.trim());
  return Response.json({
    ok: true,
    configured: Object.fromEntries(
      ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "ANTHROPIC_API_KEY", "DEMO_ACCESS_CODE"].map((n) => [n, set(n)]),
    ),
  });
}
