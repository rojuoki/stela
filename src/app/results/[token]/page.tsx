import Link from "next/link";
export default function Page() {
  return <main className="mx-auto max-w-xl px-6 py-16"><h1 className="text-2xl">This is a legacy results link</h1><p className="my-5 text-sm text-zinc-400">STELA has moved to IO. Legacy purchases and results are not migrated automatically.</p><Link href="/io/my-results" className="underline">Open My Results in IO</Link></main>;
}
