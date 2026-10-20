import Link from "next/link";

export function IoFooter() {
  return <footer className="mt-auto flex flex-wrap items-center justify-between gap-4 border-t border-border px-5 py-6 text-xs text-zinc-600 md:px-8"><span>© {new Date().getFullYear()} STELA</span><nav aria-label="Legal" className="flex gap-5"><Link href="/io/privacy" className="hover:text-zinc-300">Privacy</Link><Link href="/io/terms" className="hover:text-zinc-300">Terms</Link></nav></footer>;
}
