import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getAccountByUsername } from "@/lib/repository";
import { getUserByUsername, createStats, XApiStop } from "@/lib/xclient";
import { normalizeUsername } from "@/lib/validation";
import { getDb } from "@/lib/db";

interface Account {
  account_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
  protected: boolean;
  source: "cache" | "api";
}

interface PageProps {
  params: Promise<{ username: string }>;
}

/**
 * Fetch account data for the preview page.
 * Reuses the same logic as /api/account but directly calls the functions.
 */
async function getAccountData(username: string): Promise<Account | null> {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    return null;
  }

  // Check DB cache first
  const cachedAccount = getAccountByUsername(normalizedUsername);
  if (cachedAccount) {
    return {
      account_id: cachedAccount.account_id,
      username: cachedAccount.username,
      display_name: cachedAccount.display_name,
      avatar_url: cachedAccount.avatar_url,
      created_at: cachedAccount.created_at,
      protected: cachedAccount.protected === 1,
      source: "cache"
    };
  }

  // Fetch from X API if not cached
  try {
    const stats = createStats();
    const user = await getUserByUsername(normalizedUsername, stats);
    
    // Store in DB for future cache hits
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO accounts (account_id, username, display_name, avatar_url, created_at, protected, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.username.toLowerCase(),
      user.name,
      null, // avatar_url not returned by getUserByUsername
      user.created_at,
      user.protected ? 1 : 0,
      new Date().toISOString()
    );

    return {
      account_id: user.id,
      username: user.username,
      display_name: user.name,
      avatar_url: null,
      created_at: user.created_at,
      protected: user.protected,
      source: "api"
    };
  } catch (error) {
    if (error instanceof XApiStop) {
      // Account not found, protected, suspended, etc.
      return null;
    }
    // Re-throw other errors
    throw error;
  }
}

/**
 * Format the account creation date for display.
 */
function formatJoinDate(createdAt: string | null): string {
  if (!createdAt) return "Date unknown";
  
  try {
    const date = new Date(createdAt);
    return date.toLocaleDateString("en-US", { 
      year: "numeric", 
      month: "long" 
    });
  } catch {
    return "Date unknown";
  }
}

/**
 * Generate metadata for the preview page.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const username = resolvedParams.username;
  
  const account = await getAccountData(username);
  
  if (!account) {
    return {
      title: `@${username} — Account not found | Stela`,
      description: `The account @${username} could not be found or may be protected.`,
    };
  }

  const displayName = account.display_name || `@${account.username}`;
  
  return {
    title: `${displayName} — Earliest posts on X | Stela`,
    description: `Discover the earliest posts of ${displayName} (@${account.username}). Excavate the early timeline and explore the origins of this account.`,
    openGraph: {
      title: `${displayName} — Earliest posts on X | Stela`,
      description: `Discover the earliest posts of ${displayName} (@${account.username}). Excavate the early timeline and explore the origins of this account.`,
      type: "website",
    },
    twitter: {
      card: "summary",
      title: `${displayName} — Earliest posts on X | Stela`,
      description: `Discover the earliest posts of ${displayName} (@${account.username}). Excavate the early timeline and explore the origins of this account.`,
    },
  };
}

/**
 * Server-rendered public preview page for accounts.
 * SEO-friendly with account information and excavation CTA.
 */
export default async function UserPreviewPage({ params }: PageProps) {
  const resolvedParams = await params;
  const username = resolvedParams.username;
  
  const account = await getAccountData(username);
  
  // Return 404 if account not found
  if (!account) {
    notFound();
  }

  const displayName = account.display_name || `@${account.username}`;
  const joinDate = formatJoinDate(account.created_at);
  
  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      {/* Navigation */}
      <div className="mb-8">
        <Link 
          href="/" 
          className="text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Stela
        </Link>
      </div>

      {/* Account Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">{displayName}</h1>
        <p className="text-zinc-400 mb-4">@{account.username}</p>
        <p className="text-zinc-500 text-sm">Joined {joinDate}</p>
      </div>

      {/* Description */}
      <div className="mb-8 p-6 bg-zinc-900 rounded-xl border border-zinc-800">
        <h2 className="text-lg font-semibold mb-3">Discover Early Posts</h2>
        <p className="text-zinc-300 mb-4">
          Explore the earliest posts from {displayName}'s timeline. 
          Uncover their first thoughts, early interactions, and the origins of their presence on X.
        </p>
        <p className="text-zinc-400 text-sm">
          Excavation reveals up to 100 of the earliest posts, providing unique insights into 
          an account's history and evolution over time.
        </p>
      </div>

      {/* Protected Account Warning */}
      {account.protected && (
        <div className="mb-8 p-4 bg-orange-900/20 border border-orange-800/50 rounded-lg">
          <div className="flex items-center gap-2 text-orange-300 text-sm">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
            This account is protected and cannot be excavated.
          </div>
        </div>
      )}

      {/* Call to Action */}
      <div className="text-center">
        {account.protected ? (
          <div className="inline-flex items-center gap-2 bg-zinc-800 text-zinc-400 font-semibold px-6 py-3 rounded-lg cursor-not-allowed">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
            Account Protected
          </div>
        ) : (
          <Link
            href={`/?username=${encodeURIComponent(account.username)}`}
            className="inline-flex items-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            Excavate Earliest Posts
          </Link>
        )}
      </div>

      {/* Additional Context */}
      <div className="mt-12 pt-8 border-t border-zinc-800">
        <h3 className="text-lg font-semibold mb-4">About Timeline Excavation</h3>
        <div className="space-y-4 text-sm text-zinc-400">
          <p>
            <strong className="text-zinc-300">What is excavation?</strong><br />
            Timeline excavation uses advanced techniques to discover and retrieve 
            the earliest posts from an account's history, even when they're buried 
            deep in the timeline.
          </p>
          <p>
            <strong className="text-zinc-300">Why earliest posts?</strong><br />
            Early posts often reveal authentic thoughts, genuine interactions, and 
            the evolution of ideas before accounts became widely followed.
          </p>
          <p>
            <strong className="text-zinc-300">How it works:</strong><br />
            Our system searches through years of posts to find and present 
            the chronologically oldest content, providing a unique window into 
            an account's origins.
          </p>
        </div>
      </div>
    </main>
  );
}