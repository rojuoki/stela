"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useUser } from "@/contexts/UserContext";
import { useRouter } from "next/navigation";

const CREDIT_PACKAGES = [
  { credits: 1, price: 1 },
  { credits: 3, price: 3 },
  { credits: 10, price: 10 },
  { credits: 20, price: 20 },
];

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
      // Dev bypass - handle at frontend level
      const isDev = process.env.NODE_ENV === 'development';
      
      if (isDev) {
        // Existing dev flow - direct purchase
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
      } else {
        // Production Stripe flow
        const response = await fetch("/api/checkout/credit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ creditAmount: amount }),
          credentials: "include",
        });

        if (response.ok) {
          const { checkoutUrl } = await response.json();
          window.location.href = checkoutUrl;
        } else {
          const data = await response.json();
          setError(data.error || "Checkout failed");
        }
      }
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
    <main className="max-w-md mx-auto px-4 py-12">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Link
            href="/account"
            className="text-zinc-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">Buy Credits</h1>
        </div>
        <p className="text-zinc-500 text-sm mt-2">
          Purchase credits to unlock earliest posts
        </p>
      </div>

      {/* Credit Purchase Form */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
        {/* Success/Error Messages */}
        {success && (
          <div className="mb-4 p-3 bg-emerald-900/20 border border-emerald-800/50 rounded-lg">
            <div className="flex items-center gap-2 text-emerald-300 text-sm">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              {success}
            </div>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-800/50 rounded-lg">
            <div className="flex items-center gap-2 text-red-300 text-sm">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          </div>
        )}

        {/* Credit Icon */}
        <div className="text-center mt-2 mb-4">
          <svg className="w-12 h-12 text-yellow-400 mx-auto mb-5" fill="currentColor" viewBox="0 0 20 20">
            <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059-.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
          </svg>
          <div className="flex flex-wrap items-baseline justify-center gap-x-2 gap-y-1 text-white">
            <span className="text-xl font-semibold text-zinc-300">Balance:</span>
            <span className="text-3xl font-bold tabular-nums text-white">{credits}</span>
            <span className="text-xl font-semibold text-zinc-300">credits</span>
          </div>
        </div>

        <div className="space-y-3">
          {CREDIT_PACKAGES.map((pkg) => (
            <div
              key={pkg.credits}
              className="border border-zinc-700 rounded-lg p-3 hover:border-zinc-600 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{pkg.credits}</span>
                  <span className="text-zinc-400 text-sm">
                    {pkg.credits === 1 ? 'credit' : 'credits'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bold">${pkg.price}</span>
                  <button
                    onClick={() => handlePurchase(pkg.credits)}
                    disabled={purchasing === pkg.credits}
                    className="bg-white hover:bg-zinc-200 text-black font-medium py-1 px-3 rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {purchasing === pkg.credits ? (
                      <div className="flex items-center gap-1">
                        <div className="animate-spin rounded-full h-3 w-3 border border-current border-t-transparent"></div>
                        <span>...</span>
                      </div>
                    ) : (
                      "Buy"
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 pt-4 border-t border-zinc-800">
          <p className="text-zinc-500 text-xs text-center">
            1 credit = 1 account excavation • Credits never expire
          </p>
        </div>
      </div>

      {/* Back to Account */}
      <div className="text-center mt-8">
        <Link href="/account" className="text-zinc-500 hover:text-zinc-300 transition-colors text-sm">
          ← Back to Account
        </Link>
      </div>
    </main>
  );
}