"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useUser } from "@/contexts/UserContext";
import { useRouter } from "next/navigation";

const CREDIT_PACKAGES = [
  { credits: 1, price: 4, popular: false },
  { credits: 3, price: 10, popular: true, savings: 17 },
  { credits: 10, price: 30, popular: false, savings: 25 },
];

const PREMIUM_PACKAGE = {
  credits: 20,
  price: 70,
  savings: 13,
  label: "for deep analysis"
};

export default function CreditPurchasePage() {
  const { user, loading: userLoading, credits, refreshCredits } = useUser();
  const router = useRouter();
  const [purchasing, setPurchasing] = useState<number | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Redirect if not logged in
  useEffect(() => {
    if (!userLoading && !user) {
      router.push("/login");
    }
  }, [user, userLoading, router]);

  const handlePurchase = async (amount: number) => {
    if (!user) return;

    setPurchasing(amount);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch("/api/account/credits/purchase", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount }),
        credentials: "include",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Purchase failed");
      }

      setSuccess(data.message);
      await refreshCredits();
      
      // Auto-hide success message after 3 seconds
      setTimeout(() => setSuccess(null), 3000);

    } catch (err) {
      setError(err instanceof Error ? err.message : "Purchase failed");
    } finally {
      setPurchasing(null);
    }
  };

  if (userLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <Link
            href="/account"
            className="text-zinc-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="text-2xl font-bold">Get More Credits</h1>
        </div>
        <p className="text-zinc-400">
          Purchase credits to unlock more earliest posts from X accounts
        </p>
      </div>

      {/* Current Credits Display */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold mb-1">Current Balance</h3>
            <p className="text-zinc-400 text-sm">Your available credits for excavations</p>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 text-2xl font-bold">
              <svg className="w-6 h-6 text-zinc-400" fill="currentColor" viewBox="0 0 20 20">
                <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
              </svg>
              <span className="text-zinc-200">{credits}</span>
            </div>
            <p className="text-zinc-500 text-sm">credits available</p>
          </div>
        </div>
      </div>

      {/* Success/Error Messages */}
      {success && (
        <div className="mb-6 p-4 bg-emerald-900/20 border border-emerald-800/50 rounded-lg">
          <div className="flex items-center gap-2 text-emerald-300">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            {success}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-6 p-4 bg-red-900/20 border border-red-800/50 rounded-lg">
          <div className="flex items-center gap-2 text-red-300">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            {error}
          </div>
        </div>
      )}

      {/* Main Credit Packages */}
      <div className="grid gap-6 md:grid-cols-3 mb-8">
        {CREDIT_PACKAGES.map((pkg) => (
          <div
            key={pkg.credits}
            className={`relative bg-zinc-900 border rounded-xl p-6 ${
              pkg.popular 
                ? "border-blue-500 ring-2 ring-blue-500/20" 
                : "border-zinc-800 hover:border-zinc-700"
            } transition-colors`}
          >
            {pkg.popular && (
              <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
                <span className="inline-flex items-center px-3 py-1 bg-blue-500 text-white text-sm font-medium rounded-full">
                  Most Popular
                </span>
              </div>
            )}

            <div className="text-center mb-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <svg className="w-8 h-8 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059-.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
                </svg>
                <span className="text-3xl font-bold">{pkg.credits}</span>
              </div>
              <p className="text-zinc-400 text-sm">
                {pkg.credits === 1 ? 'credit' : 'credits'}
              </p>
              
              {pkg.savings && (
                <div className="mt-2">
                  <span className="inline-flex items-center px-2 py-1 bg-emerald-900/50 text-emerald-300 text-xs font-medium rounded-full">
                    Save {pkg.savings}%
                  </span>
                </div>
              )}
            </div>

            <div className="text-center mb-6">
              <div className="text-2xl font-bold mb-1">${pkg.price}</div>
              <p className="text-zinc-500 text-sm">
                ${(pkg.price / pkg.credits).toFixed(2)} per credit
              </p>
            </div>

            <button
              onClick={() => handlePurchase(pkg.credits)}
              disabled={purchasing === pkg.credits}
              className={`w-full py-3 px-4 rounded-lg font-semibold transition-colors ${
                pkg.popular
                  ? "bg-blue-500 hover:bg-blue-600 text-white"
                  : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {purchasing === pkg.credits ? (
                <div className="flex items-center justify-center gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent"></div>
                  Processing...
                </div>
              ) : (
                `Purchase ${pkg.credits} Credit${pkg.credits === 1 ? '' : 's'}`
              )}
            </button>
          </div>
        ))}
      </div>

      {/* Premium Package - for deep analysis */}
      <div className="mb-8">
        <div className="max-w-md mx-auto">
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6 hover:border-zinc-700/50 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <svg className="w-6 h-6 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059-.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
                  </svg>
                  <span className="text-xl font-bold">{PREMIUM_PACKAGE.credits}</span>
                </div>
                <div className="text-left">
                  <div className="text-zinc-300 font-medium">credits</div>
                  <div className="text-xs text-zinc-500">{PREMIUM_PACKAGE.label}</div>
                </div>
              </div>
              
              <div className="text-right">
                <div className="text-xl font-bold mb-1">${PREMIUM_PACKAGE.price}</div>
                <div className="text-xs text-zinc-500">
                  ${(PREMIUM_PACKAGE.price / PREMIUM_PACKAGE.credits).toFixed(2)} per credit
                </div>
              </div>
              
              <button
                onClick={() => handlePurchase(PREMIUM_PACKAGE.credits)}
                disabled={purchasing === PREMIUM_PACKAGE.credits}
                className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 py-2 px-4 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {purchasing === PREMIUM_PACKAGE.credits ? (
                  <div className="flex items-center gap-2">
                    <div className="animate-spin rounded-full h-3 w-3 border-2 border-current border-t-transparent"></div>
                    <span className="text-sm">Processing...</span>
                  </div>
                ) : (
                  <span className="text-sm">Purchase</span>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* How Credits Work */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-4">How Credits Work</h3>
        <div className="grid gap-4 md:grid-cols-2 text-sm text-zinc-400">
          <div className="flex gap-3">
            <svg className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <div>
              <p className="font-medium text-zinc-300 mb-1">1 Credit = 1 Account Excavation</p>
              <p>Each excavation unlocks up to 100 earliest posts from any public X account</p>
            </div>
          </div>
          <div className="flex gap-3">
            <svg className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
            </svg>
            <div>
              <p className="font-medium text-zinc-300 mb-1">No Expiration</p>
              <p>Credits never expire and can be used anytime you want to explore new accounts</p>
            </div>
          </div>
          <div className="flex gap-3">
            <svg className="w-5 h-5 text-purple-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="font-medium text-zinc-300 mb-1">Instant Processing</p>
              <p>Credits are added immediately and excavations start right away</p>
            </div>
          </div>
          <div className="flex gap-3">
            <svg className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            <div>
              <p className="font-medium text-zinc-300 mb-1">Free Re-access</p>
              <p>Once unlocked, you can revisit results anytime without spending additional credits</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}