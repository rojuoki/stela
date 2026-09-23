import Link from "next/link"
import { ProfileBanner } from "@/components/dashboard/profile-banner"
import { SavedTimeline } from "@/components/dashboard/saved-timeline"
import type { TweetData } from "@/components/types"

const samples = [
  "朝の空気が少し変わった。今日は古いメモを読み返しながら、次に作るものを考えています。",
  "小さな更新を公開しました。使ってみて気づいたことがあれば教えてください。",
  "散歩の途中で見つけた景色。記録しておくと、あとから時間の流れがよく見える。",
  "調べものをしていたら、思いがけず昔の投稿に戻ってきた。過去の自分との距離がおもしろい。",
  "今日は作業の日。目立たない部分を少しずつ整えています。",
  "イベントに来てくれた皆さん、ありがとうございました。次回も楽しみにしています。",
]

const posts: TweetData[] = Array.from({ length: 360 }, (_, index) => {
  const date = new Date(Date.UTC(2017, 0, 6 + index * 2, 8 + (index % 12), (index * 7) % 60))
  const spike = index === 128 ? 4200 : index === 274 ? 1600 : 0
  return {
    post_id: `demo-${String(index + 1).padStart(4, "0")}`,
    account_id: "stela-demo",
    created_at: date.toISOString(),
    full_text: `${samples[index % samples.length]} ${index + 1}`,
    media_json: null,
    like_count: 4 + ((index * 17) % 180) + spike,
    retweet_count: 1 + ((index * 7) % 48) + Math.floor(spike / 3),
    reply_count: (index * 3) % 24,
  }
})

export default function DemoTimelinePage() {
  return (
    <main className="mx-auto max-w-7xl bg-background text-foreground">
      <div className="flex items-center justify-between border-b border-border bg-secondary/20 px-5 py-2 text-xs text-muted-foreground md:px-8">
        <span>DESIGN PREVIEW · ダミーデータ</span>
        <Link href="/io" className="hover:text-foreground">検索へ戻る</Link>
      </div>
      <ProfileBanner
        compact
        searchHref="/io"
        account={{
          username: "stela_demo",
          display_name: "STELA タイムライン・プレビュー",
          description: "結果画面の操作とレイアウトを確認するためのデモアカウントです。",
          created_at: "2011-04-18T00:00:00.000Z",
          followers_count: 12840,
          following_count: 436,
        }}
      />
      <SavedTimeline tweets={posts} username="stela_demo" />
    </main>
  )
}
