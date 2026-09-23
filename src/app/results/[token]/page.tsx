import Link from "next/link";
export default function Page() {
  return <main className="mx-auto max-w-xl px-6 py-16"><h1 className="text-2xl">旧版の結果リンクです</h1><p className="my-5 text-sm text-zinc-400">STELAはIO版に移行しました。旧版の購入・結果は自動移行されません。</p><Link href="/io/my-results" className="underline">IO版のMy Resultsを開く</Link></main>;
}
