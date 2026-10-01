export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center">
      <form action="/api/login" method="post" className="w-80 space-y-4 rounded-xl border border-zinc-800 p-6">
        <h1 className="text-lg font-semibold">Rationode</h1>
        {next && next !== "/" && <p className="text-xs text-zinc-400">Workspace <span className="font-mono">{next.split("/")[1]}</span></p>}
        <input type="hidden" name="next" value={next ?? ""} />
        <input name="code" type="password" placeholder="Access code" autoFocus
               className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2" />
        {error === "workspace" ? <p className="text-sm text-red-400">Your access code doesn&apos;t open this workspace. Enter its code.</p>
          : error && <p className="text-sm text-red-400">That code isn&apos;t right.</p>}
        <button className="w-full rounded-md bg-emerald-600 py-2 font-medium text-white hover:bg-emerald-500">Enter</button>
      </form>
    </main>
  );
}
