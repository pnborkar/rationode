export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
      <form action="/api/login" method="post" className="w-80 space-y-4 rounded-xl border border-zinc-800 p-6">
        <h1 className="text-lg font-semibold">Rationode demo</h1>
        <input name="code" type="password" placeholder="Access code" autoFocus
               className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2" />
        {error && <p className="text-sm text-red-400">That code isn&apos;t right.</p>}
        <button className="w-full rounded-md bg-emerald-600 py-2 font-medium hover:bg-emerald-500">Enter</button>
      </form>
    </main>
  );
}
