import Link from "next/link";

// An unknown path, usually a workspace that doesn't exist (demo spec §23.9: /<workspace>).
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="w-96 space-y-3 rounded-xl border border-zinc-800 p-6 text-sm">
        <h1 className="text-lg font-semibold">No such workspace</h1>
        <p className="text-zinc-400">There is no workspace or page at this address. Check the link you were given.</p>
        <Link href="/" className="inline-block rounded-md bg-zinc-800 px-3 py-1">Go to the start</Link>
      </div>
    </main>
  );
}
