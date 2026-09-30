import Link from "next/link"
import { ProfileBanner } from "@/components/dashboard/profile-banner"
import { SavedTimeline } from "@/components/dashboard/saved-timeline"
import type { TweetData } from "@/components/types"

const samples = [
  "The air felt different this morning. I’m rereading old notes and thinking about what to build next.",
  "A small update is live. Let me know what you notice when you try it.",
  "A view from today’s walk. Keeping a record makes the passage of time easier to see.",
  "Research led me back to an old post. The distance from my past self is fascinating.",
  "A day for quiet work, improving the parts no one usually notices.",
  "Thank you to everyone who joined the event. Looking forward to the next one.",
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
        <span>DESIGN PREVIEW · SAMPLE DATA</span>
        <Link href="/io" className="hover:text-foreground">Back to search</Link>
      </div>
      <ProfileBanner
        compact
        searchHref="/io"
        account={{
          username: "stela_demo",
          display_name: "STELA Timeline Preview",
          description: "A demo account for reviewing the results screen and timeline controls.",
          created_at: "2011-04-18T00:00:00.000Z",
          followers_count: 12840,
          following_count: 436,
        }}
      />
      <SavedTimeline tweets={posts} username="stela_demo" />
    </main>
  )
}
