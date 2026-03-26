"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EngagementChart } from "../../../components/EngagementChart";
import { TweetCard } from "../../../components/TweetCard";
import { AccountHeader } from "../../../components/AccountHeader";
import { JobStatus } from "../../../components/JobStatus";
import { useUser } from "../../../contexts/UserContext";
import type { TweetData, AccountData, Status, JobPhase } from "../../../components/types";

interface TemporaryUnlockData {
  token: string;
  account_id: string;
  username: string;
  tweets: TweetData[];
  job_id: string | null;
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
  const [isExcavating, setIsExcavating] = useState(false);
  
  // Job status tracking
  const [jobStatus, setJobStatus] = useState<Status>("idle");
  const [jobPhase, setJobPhase] = useState<JobPhase>(null);
  const [jobInfo, setJobInfo] = useState<string>("");
  const [jobResumeAt, setJobResumeAt] = useState<string | null>(null);

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
        
        // Check if this is placeholder/excavating data
        const isPlaceholder = result.tweets?.some((tweet: TweetData) => 
          tweet.post_id?.startsWith('excavating_') || 
          tweet.full_text?.includes('🔄 Excavation in progress')
        );
        setIsExcavating(isPlaceholder);
        
        // Initialize job status if this is a guest result with active excavation
        if (isPlaceholder && result.job_id) {
          setJobStatus("running");
          setJobPhase("running");
          setJobInfo("Starting excavation...");
        }

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

  // Polling for excavation completion
  useEffect(() => {
    if (!isExcavating || !token) return;

    const pollInterval = 5000; // Poll every 5 seconds
    let pollTimer: NodeJS.Timeout;

    const pollForUpdates = async () => {
      try {
        const response = await fetch(`/api/results/${token}`);
        if (response.ok) {
          const result = await response.json();
          
          // Check if excavation is still in progress
          const stillExcavating = result.tweets?.some((tweet: TweetData) => 
            tweet.post_id?.startsWith('excavating_') || 
            tweet.full_text?.includes('🔄 Excavation in progress')
          );

          if (!stillExcavating) {
            // Excavation completed - update data and stop polling
            setData(result);
            setIsExcavating(false);
            console.log(`[results] Excavation completed for token ${token}`);
          } else {
            // Still excavating - schedule next poll
            pollTimer = setTimeout(pollForUpdates, pollInterval);
          }
        } else {
          // Error occurred - stop polling and let user refresh manually
          console.warn(`[results] Polling error for token ${token}:`, response.status);
          setIsExcavating(false);
        }
      } catch (err) {
        // Network error - stop polling
        console.warn(`[results] Polling network error for token ${token}:`, err);
        setIsExcavating(false);
      }
    };

    // Start polling after initial load
    pollTimer = setTimeout(pollForUpdates, pollInterval);
    console.log(`[results] Started polling for excavation completion: ${token}`);

    return () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        console.log(`[results] Stopped polling for token ${token}`);
      }
    };
  }, [isExcavating, token]);

  // Job status polling for guest results with active excavation
  useEffect(() => {
    if (!data?.job_id || !isExcavating) return;

    const pollInterval = 3000; // Poll every 3 seconds for job status
    let pollTimer: NodeJS.Timeout;

    const pollJobStatus = async () => {
      try {
        const response = await fetch(`/api/jobs/${data.job_id}`);
        if (response.ok) {
          const jobData = await response.json();
          
          // Update job status for UI display
          const status = jobData.status;
          setJobResumeAt(jobData.resumeAt);
          
          if (status === 'waiting_rate_limit') {
            setJobStatus("running");
            setJobPhase("waiting_rate_limit");
            setJobInfo("API rate limit - will resume automatically");
          } else if (status === 'queued') {
            setJobStatus("running");
            setJobPhase("queued");
            const position = jobData.queuePosition;
            setJobInfo(position ? `Position ${position} in queue` : "Queued for excavation");
          } else if (status === 'running') {
            setJobStatus("running");
            setJobPhase("running");
            setJobInfo(`Excavating earliest posts (${jobData.apiCalls || 0} API calls)`);
          } else if (status === 'succeeded') {
            // Job completed - the main result polling will pick up the new data
            setJobStatus("done");
            setJobPhase(null);
            setJobInfo("Excavation completed");
          } else if (status === 'failed') {
            setJobStatus("failed");
            setJobPhase(null);
            setJobInfo("Excavation failed");
            setIsExcavating(false); // Stop polling for results
          }
          
          // Continue polling if job is still active
          if (['queued', 'running', 'waiting_rate_limit'].includes(status)) {
            pollTimer = setTimeout(pollJobStatus, pollInterval);
          }
        } else {
          console.warn(`[results] Job status polling error for ${data.job_id}:`, response.status);
          // Continue polling on HTTP errors
          pollTimer = setTimeout(pollJobStatus, pollInterval);
        }
      } catch (err) {
        console.warn(`[results] Job status polling network error for ${data.job_id}:`, err);
        // Continue polling on network errors
        pollTimer = setTimeout(pollJobStatus, pollInterval);
      }
    };

    // Start job status polling
    pollTimer = setTimeout(pollJobStatus, pollInterval);
    console.log(`[results] Started job status polling for ${data.job_id}`);

    return () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        console.log(`[results] Stopped job status polling for ${data.job_id}`);
      }
    };
  }, [data?.job_id, isExcavating]);

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
        // Only redirect for guest users who just signed up
        // Logged-in users who used "Unlock for $3" should stay on results page
      } else {
        // For guest unlocks, show transfer error
        // For logged-in unlocks, ignore transfer errors (already recorded)
        const errorData = await response.json();
        if (!data || errorData.error !== 'Unlock not found, expired, or already transferred') {
          setError(errorData.error || 'Failed to save unlock');
        }
      }
    } catch (err) {
      // For guest unlocks, show network error
      // For logged-in unlocks, ignore transfer errors
      if (!data) {
        setError('Network error');
      }
    } finally {
      setTransferring(false);
    }
  };

  // Auto-transfer if user is already logged in (only for guest unlocks)
  useEffect(() => {
    if (!userLoading && user && data && !transferred && !transferring) {
      // Check if this was originally a guest unlock (by checking if user has consumed the temp unlock)
      // For logged-in users who created the unlock, no transfer is needed
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

      {/* Account Creation Prompt - only for guest users */}
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
              Plus you'll get 4 free credits to unlock more accounts.
            </p>
            <div className="flex items-center justify-center gap-3">
              <Link
                href={`/signup?returnTo=${encodeURIComponent(`/results/${token}`)}`}
                className="bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold px-6 py-3 rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all"
              >
                Create Account
              </Link>
              <Link
                href={`/login?returnTo=${encodeURIComponent(`/results/${token}`)}`}
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

      {/* Silently handle auto-transfer for logged-in users - no UI needed */}

      {/* Job Status - show for guest results with active excavation */}
      {data?.job_id && isExcavating && (
        <JobStatus
          status={jobStatus}
          jobPhase={jobPhase}
          jobInfo={jobInfo}
          error={null}
          credits={0} // Guest users don't have credits
          cacheHit={false}
          resumeAt={jobResumeAt}
        />
      )}

      {/* Results Display */}
      <div className="mb-4">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-xl font-bold">Earliest Posts from {displayName}</h1>
          {isExcavating ? (
            <div className="inline-flex items-center px-2 py-1 bg-amber-900/50 text-amber-300 text-xs font-medium rounded-full">
              <div className="animate-spin rounded-full h-3 w-3 border border-amber-300 border-t-transparent mr-1.5"></div>
              Excavating
            </div>
          ) : (
            <div className="inline-flex items-center px-2 py-1 bg-emerald-900/50 text-emerald-300 text-xs font-medium rounded-full">
              Unlocked
            </div>
          )}
        </div>
        <p className="text-sm text-zinc-400">
          {isExcavating ? (
            <>Excavation started on {formatDate(data.created_at)} • Results will appear shortly</>
          ) : (
            <>Unlocked on {formatDate(data.created_at)} • {data.tweets.length} posts found</>
          )}
        </p>
      </div>

      {/* Engagement Chart */}
      {hasResults && <EngagementChart tweets={data.tweets} />}

      {/* Tweet list */}
      {isExcavating ? (
        <div className="border border-zinc-800 rounded-xl min-h-[200px] flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4"></div>
            <h3 className="text-lg font-semibold text-white mb-2">Excavating Earliest Posts</h3>
            <p className="text-sm text-zinc-400 mb-2">
              Our system is working to discover the earliest posts from {displayName}'s timeline. 
              This process can take a few minutes depending on the account's history.
            </p>
            <p className="text-xs text-zinc-500">
              Results will automatically appear when excavation is complete. No need to refresh the page.
            </p>
          </div>
        </div>
      ) : hasResults ? (
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