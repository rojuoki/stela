"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useUser } from "@/contexts/UserContext";
import { useRouter } from "next/navigation";
import { SUBSCRIPTION_ENABLED } from "@/lib/featureFlags";

export default function AccountDashboard() {
  const { user, loading, credits, subscription } = useUser();
  const router = useRouter();

  // Redirect if not logged in
  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading || !user) {
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
        <h1 className="text-2xl font-bold mb-2">Account Dashboard</h1>
        <p className="text-zinc-400">
          Manage your account and view your excavation activity
        </p>
      </div>

      {/* User Info Card */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 bg-gradient-to-br from-blue-400 to-purple-500 rounded-full flex items-center justify-center text-xl font-bold text-white">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-xl font-semibold">{user.name}</h2>
              {SUBSCRIPTION_ENABLED && (
                subscription.plan === 'basic' ? (
                  <div className="flex items-center gap-1.5 bg-gradient-to-r from-blue-600/20 to-purple-600/20 border border-blue-500/30 px-2.5 py-1 rounded-full text-xs">
                    <svg className="w-3.5 h-3.5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                    </svg>
                    <span className="font-medium text-blue-300">Basic Subscriber</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 px-2.5 py-1 rounded-full text-xs">
                    <span className="text-zinc-400">Free Plan</span>
                  </div>
                )
              )}
            </div>
            <p className="text-zinc-400 mb-2">{user.email}</p>
            {SUBSCRIPTION_ENABLED && subscription.plan === 'basic' && subscription.cycleEnd && (
              <p className="text-xs text-zinc-500">
                Next billing: {new Date(subscription.cycleEnd).toLocaleDateString()} • {subscription.creditsPerCycle || 4} credits/month
              </p>
            )}
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 text-lg mb-1">
              <svg className="w-5 h-5 text-zinc-400" fill="currentColor" viewBox="0 0 20 20">
                <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
              </svg>
              <span className="font-bold text-zinc-200">{credits}</span>
              <span className="text-zinc-400 text-sm">credits</span>
            </div>
            <p className="text-xs text-zinc-500">
              {credits === 0 ? "Get more credits" : `${credits} available`}
            </p>
          </div>
        </div>
      </div>

      {/* Quick Actions Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-8">
        {/* My Unlocks */}
        <Link
          href="/account/unlocks"
          className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 hover:border-zinc-700 transition-colors group"
        >
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 bg-blue-900/50 rounded-lg flex items-center justify-center group-hover:bg-blue-900/70 transition-colors">
              <svg className="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <svg className="w-5 h-5 text-zinc-500 group-hover:text-zinc-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold mb-2">My Unlocks</h3>
          <p className="text-zinc-400 text-sm">
            View your excavation history and unlocked accounts
          </p>
        </Link>

        {/* Subscription/Credits */}
        {SUBSCRIPTION_ENABLED && (
          subscription.plan === 'basic' ? (
            <Link
              href="/account/subscription"
              className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 hover:border-zinc-700 transition-colors group"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-900/50 to-purple-900/50 rounded-lg flex items-center justify-center group-hover:bg-gradient-to-br group-hover:from-blue-900/70 group-hover:to-purple-900/70 transition-all">
                  <svg className="w-6 h-6 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                  </svg>
                </div>
                <svg className="w-5 h-5 text-zinc-500 group-hover:text-zinc-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">Manage Subscription</h3>
              <p className="text-zinc-400 text-sm">
                View billing, update payment method, cancel subscription
              </p>
              <div className="mt-3">
                <span className="inline-flex items-center px-2 py-1 bg-gradient-to-r from-blue-900/50 to-purple-900/50 text-blue-300 text-xs font-medium rounded-full">
                  Basic • Active
                </span>
              </div>
            </Link>
          ) : (
            <Link
              href="/subscribe"
              className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 hover:border-zinc-700 transition-colors group"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-900/50 to-purple-900/50 rounded-lg flex items-center justify-center group-hover:bg-gradient-to-br group-hover:from-blue-900/70 group-hover:to-purple-900/70 transition-all">
                  <svg className="w-6 h-6 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                  </svg>
                </div>
                <svg className="w-5 h-5 text-zinc-500 group-hover:text-zinc-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">Subscribe to Basic</h3>
              <p className="text-zinc-400 text-sm">
                Get 4 unlock credits per month • Better value than buying individual unlocks
              </p>
              <div className="mt-3">
                <span className="inline-flex items-center px-2 py-1 bg-blue-900/50 text-blue-300 text-xs font-medium rounded-full">
                  $12/month
                </span>
              </div>
            </Link>
          )
        )}

        {/* Buy Credits */}
        <Link
          href="/account/credits"
          className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 hover:border-zinc-700 transition-colors group"
        >
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 bg-emerald-900/50 rounded-lg flex items-center justify-center group-hover:bg-emerald-900/70 transition-colors">
              <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <svg className="w-5 h-5 text-zinc-500 group-hover:text-zinc-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold mb-2">Buy Credits</h3>
          <p className="text-zinc-400 text-sm">
            Purchase credits to unlock accounts
          </p>
          <div className="mt-3">
            <span className="inline-flex items-center px-2 py-1 bg-emerald-900/50 text-emerald-300 text-xs font-medium rounded-full">
              {SUBSCRIPTION_ENABLED ? "$1 • No subscription" : "$1"}
            </span>
          </div>
          {credits === 0 && (
            <div className="mt-2">
              <span className="inline-flex items-center px-2 py-1 bg-orange-900/50 text-orange-300 text-xs font-medium rounded-full">
                No Credits Available
              </span>
            </div>
          )}
        </Link>

        {/* Account Settings - Placeholder */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 opacity-75">
          <div className="flex items-start justify-between mb-4">
            <div className="w-12 h-12 bg-zinc-800 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div className="inline-flex items-center px-2 py-1 bg-orange-900/50 text-orange-300 text-xs font-medium rounded-full">
              Coming Soon
            </div>
          </div>
          <h3 className="text-lg font-semibold mb-2">Settings</h3>
          <p className="text-zinc-400 text-sm">
            Manage your account preferences and security
          </p>
        </div>
      </div>

      {/* Recent Activity Placeholder */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-4">Quick Start</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-zinc-800 rounded-lg">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <div>
                <p className="font-medium">Explore new accounts</p>
                <p className="text-sm text-zinc-400">Start excavating earliest posts</p>
              </div>
            </div>
            <Link
              href="/"
              className="text-blue-400 hover:text-blue-300 transition-colors text-sm font-medium"
            >
              Search →
            </Link>
          </div>
          
          <div className="flex items-center justify-between p-3 bg-zinc-800 rounded-lg">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <div>
                <p className="font-medium">View your unlocks</p>
                <p className="text-sm text-zinc-400">See your excavation history</p>
              </div>
            </div>
            <Link
              href="/account/unlocks"
              className="text-emerald-400 hover:text-emerald-300 transition-colors text-sm font-medium"
            >
              View →
            </Link>
          </div>

          {credits === 0 && (
            <div className="flex items-center justify-between p-3 bg-zinc-800 rounded-lg border border-orange-800/50">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-orange-400" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
                </svg>
                <div>
                  <p className="font-medium text-orange-300">Get more credits</p>
                  <p className="text-sm text-zinc-400">You need credits to unlock accounts</p>
                </div>
              </div>
              <Link
                href="/account/credits"
                className="text-orange-400 hover:text-orange-300 transition-colors text-sm font-medium"
              >
                Purchase →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}