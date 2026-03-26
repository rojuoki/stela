"use client";

import { useState } from "react";
import Link from "next/link";
import { useUser } from "../../contexts/UserContext";
import { useRouter } from "next/navigation";

export default function BuyUnlockPage() {
  const { user, credits, refreshCredits } = useUser();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePurchase = async () => {
    setLoading(true);
    setError(null);

    try {
      // Placeholder for actual payment processing
      // In real implementation, this would integrate with Stripe
      const response = await fetch('/api/purchase/unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });

      if (response.ok) {
        await refreshCredits();
        router.push('/'); // Redirect to home or back to the account they were viewing
      } else {
        const data = await response.json();
        setError(data.error || 'Purchase failed');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="max-w-lg mx-auto px-4 py-12">
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

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-white/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold mb-2">Buy 1 Unlock</h1>
          <p className="text-zinc-400">
            Purchase a single unlock to excavate earliest posts from any account
          </p>
        </div>

        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium">1 Unlock Credit</span>
            <span className="text-xl font-bold">$4</span>
          </div>
          <p className="text-sm text-zinc-400">
            Unlock up to 100 earliest posts from any account. Credits never expire.
          </p>
          {user && (
            <div className="mt-3 pt-3 border-t border-zinc-600 text-xs text-zinc-500">
              Current balance: {credits} credit{credits !== 1 ? 's' : ''}
            </div>
          )}
        </div>

        {!user && (
          <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg p-4 mb-6">
            <div className="flex items-center gap-2 text-blue-300 mb-2">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
              <span className="font-medium">Account Required</span>
            </div>
            <p className="text-sm text-blue-100 mb-3">
              You'll need to sign in or create an account to complete your purchase.
            </p>
            <div className="flex gap-2">
              <Link
                href="/login"
                className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 transition-colors"
              >
                Sign In
              </Link>
              <Link
                href="/signup"
                className="text-xs bg-zinc-700 text-white px-3 py-1.5 rounded hover:bg-zinc-600 transition-colors"
              >
                Create Account
              </Link>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-4 mb-6">
            <div className="flex items-center gap-2 text-red-300">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          </div>
        )}

        <button
          onClick={handlePurchase}
          disabled={loading || !user}
          className="w-full bg-white text-black font-semibold py-3 px-6 rounded-lg hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Processing...' : 'Purchase for $4'}
        </button>

        <div className="mt-4 text-center text-xs text-zinc-500">
          <p>🔒 Secure payment processing</p>
          <p className="mt-1">Credits never expire • No subscription required</p>
        </div>
      </div>

      <div className="mt-8 text-center">
        <p className="text-sm text-zinc-400 mb-3">
          Need multiple unlocks? Consider subscribing for better value.
        </p>
        <Link
          href="/subscribe"
          className="inline-flex items-center gap-2 text-white hover:text-zinc-300 underline text-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
          </svg>
          Basic Subscription - 4 unlocks/month
        </Link>
      </div>
    </main>
  );
}