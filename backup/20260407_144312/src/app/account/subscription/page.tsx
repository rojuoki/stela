"use client";

import { useState } from "react";
import Link from "next/link";
import { useUser } from "../../../contexts/UserContext";
import { useRouter } from "next/navigation";

export default function SubscriptionManagePage() {
  const { user, loading, credits, subscription, refreshCredits, refreshSubscription } = useUser();
  const router = useRouter();
  const [cancelLoading, setCancelLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Redirect if not logged in
  if (!loading && !user) {
    router.push("/login");
    return null;
  }

  // Redirect free users to subscribe page
  if (!loading && user && subscription.plan !== 'basic') {
    router.push("/subscribe");
    return null;
  }

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
      </div>
    );
  }

  const handleCancelSubscription = async () => {
    setCancelLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // TODO: Phase 4 - Implement actual subscription cancellation
      // For now, this is a placeholder
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate API call
      
      setSuccess("Your subscription will be canceled at the end of the current billing period.");
      await refreshSubscription();
      
    } catch (err) {
      setError('Failed to cancel subscription. Please try again.');
    } finally {
      setCancelLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* Back Navigation */}
      <div className="mb-8">
        <Link 
          href="/account" 
          className="text-zinc-400 hover:text-white transition-colors text-sm inline-flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Account Dashboard
        </Link>
      </div>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-2">Subscription Management</h1>
        <p className="text-zinc-400">
          Manage your Basic subscription, view billing information, and update settings
        </p>
      </div>

      {/* Current Plan Card */}
      <div className="bg-gradient-to-br from-zinc-900 to-zinc-800 border border-zinc-700 rounded-xl p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-semibold mb-1">Basic Subscription</h2>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center px-2 py-1 bg-emerald-900/50 text-emerald-300 text-xs font-medium rounded-full">
                  Active
                </span>
                <span className="text-sm text-zinc-400">$12/month</span>
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-white mb-1">{credits}</div>
            <div className="text-sm text-zinc-400">Credits available</div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-zinc-400 mb-1">Current Period</div>
            <div className="font-medium">
              {subscription.cycleEnd ? formatDate(subscription.cycleEnd) : 'Unknown'}
            </div>
          </div>
          <div>
            <div className="text-zinc-400 mb-1">Monthly Credits</div>
            <div className="font-medium">{subscription.creditsPerCycle || 4} credits</div>
          </div>
        </div>
      </div>

      {/* Benefits */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">Your Benefits</h3>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            <span className="text-sm">4 unlock credits per month (unused credits roll over)</span>
          </div>
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            <span className="text-sm">Access to all excavation features</span>
          </div>
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            <span className="text-sm">Cancel anytime</span>
          </div>
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            <span className="text-sm">No long-term commitment</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="space-y-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-lg font-semibold mb-4">Billing & Payment</h3>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b border-zinc-800 last:border-b-0">
              <div>
                <div className="font-medium">Payment Method</div>
                <div className="text-sm text-zinc-400">Update your payment information</div>
              </div>
              <div className="flex items-center gap-2 text-xs text-orange-300 bg-orange-900/20 px-2 py-1 rounded">
                Coming Soon
              </div>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-zinc-800 last:border-b-0">
              <div>
                <div className="font-medium">Billing History</div>
                <div className="text-sm text-zinc-400">View your past payments and invoices</div>
              </div>
              <div className="flex items-center gap-2 text-xs text-orange-300 bg-orange-900/20 px-2 py-1 rounded">
                Coming Soon
              </div>
            </div>

            <div className="flex items-center justify-between py-3">
              <div>
                <div className="font-medium">Next Billing Date</div>
                <div className="text-sm text-zinc-400">
                  {subscription.cycleEnd ? formatDate(subscription.cycleEnd) : 'Unknown'} • $12.00
                </div>
              </div>
              <div className="text-sm text-zinc-400">Auto-renew</div>
            </div>
          </div>
        </div>

        {/* Cancel Subscription */}
        <div className="bg-red-900/10 border border-red-800/50 rounded-xl p-6">
          <h3 className="text-lg font-semibold mb-2 text-red-300">Cancel Subscription</h3>
          <p className="text-sm text-zinc-400 mb-4">
            Your subscription will remain active until the end of your current billing period. 
            You'll keep access to all features and credits until then.
          </p>
          
          {error && (
            <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-3 mb-4">
              <div className="flex items-center gap-2 text-red-300 text-sm">
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {error}
              </div>
            </div>
          )}

          {success && (
            <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-lg p-3 mb-4">
              <div className="flex items-center gap-2 text-emerald-300 text-sm">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                {success}
              </div>
            </div>
          )}
          
          <button
            onClick={handleCancelSubscription}
            disabled={cancelLoading}
            className="bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-4 py-2 rounded-lg transition-colors text-sm"
          >
            {cancelLoading ? 'Canceling...' : 'Cancel Subscription'}
          </button>
        </div>
      </div>

      {/* Need More Credits */}
      {credits === 0 && (
        <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-lg font-semibold mb-2">Need More Credits Right Now?</h3>
          <p className="text-sm text-zinc-400 mb-4">
            While you wait for your monthly credits, you can purchase individual unlocks.
          </p>
          <Link
            href="/account/credits"
            className="inline-flex items-center gap-2 bg-white text-black font-semibold px-4 py-2 rounded-lg hover:bg-zinc-200 transition-colors text-sm"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Buy 1 Unlock - $4
          </Link>
        </div>
      )}
    </div>
  );
}