import { NextRequest, NextResponse } from "next/server";
import { getAccountByUsername, getTweetsByAccount } from "@/lib/repository";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") || "json";

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  // Validate format
  if (!["json", "csv"].includes(format)) {
    return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });
  }

  // Get tweets (no re-fetch, export only stored data)
  const tweets = await getTweetsByAccount(accountId);
  
  if (tweets.length === 0) {
    return NextResponse.json({ error: "No data found for this account" }, { status: 404 });
  }

  if (format === "csv") {
    // CSV export
    const headers = [
      "post_id",
      "created_at", 
      "full_text",
      "like_count",
      "retweet_count", 
      "reply_count"
    ];
    
    const csvRows = [
      headers.join(","),
      ...tweets.map(t => [
        `"${t.post_id}"`,
        `"${t.created_at}"`,
        `"${t.full_text.replace(/"/g, '""')}"`, // Escape quotes
        t.like_count,
        t.retweet_count,
        t.reply_count
      ].join(","))
    ];

    return new Response(csvRows.join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="stela_${accountId}_earliest.csv"`,
      },
    });
  }

  // JSON export (default)
  return NextResponse.json({
    accountId,
    exportedAt: new Date().toISOString(),
    totalPosts: tweets.length,
    posts: tweets.map(t => ({
      postId: t.post_id,
      createdAt: t.created_at,
      text: t.full_text,
      engagement: {
        likes: t.like_count,
        retweets: t.retweet_count,
        replies: t.reply_count,
      },
      media: t.media_json ? JSON.parse(t.media_json) : null,
    }))
  });
}