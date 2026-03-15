"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EngagementChart } from "../../../components/EngagementChart";
import { TweetCard } from "../../../components/TweetCard";
import { AccountHeader } from "../../../components/AccountHeader";
import { useUser } from "../../../contexts/UserContext";
import type { TweetData, AccountData } from "../../../components/types";

interface TemporaryUnlockData {
  token: string;
  account_id: string;
  username: string;
  tweets: TweetData[];
  created_at: string;
  expires_at: string;
}

export default function ResultsPage() {
  const params = useParams();
  const router = useRouter();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  
  const { user, loading: userLoading } = useUser();
  
  const [data, setData] = useState<TemporaryUnlockData | null>(null);
  const [accountData, setAccountData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [transferred, setTransferred] = useState(false);

  // Load temporary unlock data
  useEffect(() => {
    if (!token) {
      notFound();
      return;
    }

    const loadData = async () => {
      try {
        const response = await fetch(`/api/results/${token}`);
        
        if (!response.ok) {
          if (response.status === 404) {
            setError("This unlock link has expired or doesn't exist.");
          } else {
            const errorData = await response.json().catch(() => ({}));
            setError(errorData.error || 'Failed to load results');
          }
          return;
        }

        const result = await response.json();
        setData(result);

        // Load account data for header
        if (result.username) {
          const accountResponse = await fetch(`/api/account?username=${result.username}`);
          if (accountResponse.ok) {
            const accountResult = await accountResponse.json();
            setAccountData(accountResult);
          }
        }
      } catch (err) {
        setError('Network error');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [token]);

  // Transfer to account when user signs up/logs in
  const handleTransferToAccount = async () => {
    if (!user || !token) return;
    
    setTransferring(true);
    
    try {
      const response = await fetch('/api/results/transfer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
        credentials: 'include',
      });

      if (response.ok) {
        setTransferred(true);
        // Optionally redirect to account dashboard
        setTimeout(() => {
          router.push('/account/unlocks');
        }, 2000);
      } else {
        const errorData = await response.json();
        setError(errorData.error || 'Failed to save unlock');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setTransferring(false);
    }
  };

  // Auto-transfer if user is already logged in
  useEffect(() => {
    if (!userLoading && user && data && !transferred && !transferring) {
      handleTransferToAccount();
    }
  }, [user, userLoading, data, transferred, transferring]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (!token) {
    notFound();
  }

  if (loading) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4"></div>
          <p className="text-zinc-400">Loading your unlock results...</p>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center py-16">
          <div className="mb-6">
            <svg 
              className="w-16 h-16 mx-auto text-zinc-600 mb-4" 
              fill="none" 
              viewBox="0 0 24 24" 
              stroke="currentColor"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={1.5} 
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" 
              />
            </svg>
            <h1 className="text-2xl font-bold text-zinc-300 mb-2">Link Expired</h1>
            <p className="text-zinc-500 mb-6">
              {error || "This unlock link has expired or is no longer valid."}
            </p>
          </div>

          <div className="space-y-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              Search for Another Account
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const hasResults = data.tweets.length > 0;
  const displayName = accountData?.display_name || `@${data.username}`;

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
      {accountData && (
        <div className="mb-6">
          <AccountHeader
            status="found"
            data={accountData}
            error={null}
          />
        </div>
      )}

      {/* Account Creation Prompt - only for guests */}
      {!user && !transferred && (
        <div className="mb-6 bg-gradient-to-r from-blue-900/20 to-purple-900/20 border border-blue-800/50 rounded-xl p-6">
          <div className="text-center">
            <div className="w-12 h-12 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold mb-2 text-white">Create a free account to save your unlock</h3>
            <p className="text-sm text-zinc-400 mb-4 max-w-md mx-auto">
              This unlock will be saved to your account so you can access it anytime. 
              Plus you'll get 3 free credits to unlock more accounts.
            </p>
            <div className="flex items-center justify-center gap-3">
              <Link
                href="/signup"
                className="bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold px-6 py-3 rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all"
              >
                Create Account
              </Link>
              <Link
                href="/login"
                className="bg-zinc-800 text-white font-semibold px-6 py-3 rounded-lg hover:bg-zinc-700 transition-colors border border-zinc-600"
              >
                Sign In
              </Link>
            </div>
            <p className="text-xs text-zinc-500 mt-3">
              This unlock expires on {formatDate(data.expires_at)}
            </p>
          </div>
        </div>
      )}

      {/* Transfer Success Message */}
      {transferred && (
        <div className="mb-6 bg-emerald-900/20 border border-emerald-800/50 rounded-xl p-6">
          <div className="text-center">
            <div className="w-12 h-12 bg-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold mb-2 text-emerald-300">Unlock Saved Successfully!</h3>
            <p className="text-sm text-emerald-100 mb-4">
              This unlock has been saved to your account and you can access it anytime from your dashboard.
            </p>
            <Link
              href="/account/unlocks"
              className="inline-flex items-center gap-2 bg-emerald-600 text-white font-semibold px-4 py-2 rounded-lg hover:bg-emerald-700 transition-colors text-sm"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              View My Unlocks
            </Link>
          </div>
        </div>
      )}

      {/* Transfer Loading */}
      {transferring && (
        <div className="mb-6 bg-zinc-900/50 border border-zinc-700 rounded-xl p-6">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <p className="text-zinc-400">Saving unlock to your account...</p>
          </div>
        </div>
      )}

      {/* Results Display */}
      <div className="mb-4">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-xl font-bold">Earliest Posts from {displayName}</h1>
          <div className="inline-flex items-center px-2 py-1 bg-emerald-900/50 text-emerald-300 text-xs font-medium rounded-full">
            Unlocked
          </div>
        </div>
        <p className="text-sm text-zinc-400">
          Unlocked on {formatDate(data.created_at)} • {data.tweets.length} posts found
        </p>
      </div>

      {/* Engagement Chart */}
      {hasResults && <EngagementChart tweets={data.tweets} />}

      {/* Tweet list */}
      {hasResults ? (
        <div className="border border-zinc-800 rounded-xl overflow-hidden">
          {data.tweets.map((tweet) => (
            <TweetCard key={tweet.post_id} tweet={tweet} />
          ))}
        </div>
      ) : (
        <div className="border border-zinc-800 rounded-xl min-h-[200px] flex items-center justify-center">
          <p className="text-zinc-600 text-sm">No posts found.</p>
        </div>
      )}

      {/* Footer CTA */}
      <div className="mt-12 pt-8 border-t border-zinc-800 text-center">
        <h3 className="text-lg font-semibold mb-4">Discover More Accounts</h3>
        <p className="text-sm text-zinc-400 mb-6">
          Explore the earliest posts from other accounts and uncover their digital history.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          Search Another Account
        </Link>
      </div>
    </main>
  );
}