"use client";

import { useState } from "react";
import Link from "next/link";
import { useUser } from "../../contexts/UserContext";
import { useRouter } from "next/navigation";

export default function SubscribePage() {
  const { user, credits, subscription, signup, refreshCredits, refreshSubscription } = useUser();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Form state for account creation
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubscribe = async () => {
    setLoading(true);
    setError(null);

    try {
      // Dev bypass - handle at frontend level
      const isDev = process.env.NODE_ENV === 'development';
      console.log("[subscribe] === FLOW DEBUG ===");
      console.log("[subscribe] NODE_ENV:", process.env.NODE_ENV);
      console.log("[subscribe] isDev:", isDev);
      console.log("[subscribe] Selected flow:", isDev ? "DEV (direct)" : "PROD (Stripe)");
      
      if (isDev) {
        // Existing dev flow - unchanged
        const response = await fetch('/api/subscription/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 'basic' }),
          credentials: 'include',
        });
        
        if (response.ok) {
          await Promise.all([refreshCredits(), refreshSubscription()]);
          router.push('/');
        } else {
          const data = await response.json();
          setError(data.error || 'Subscription failed');
        }
      } else {
        // Production Stripe flow
        const response = await fetch('/api/checkout/subscription', {
          method: 'POST',
          credentials: 'include',
        });
        
        if (response.ok) {
          const { checkoutUrl } = await response.json();
          window.location.href = checkoutUrl;
        } else {
          const data = await response.json();
          setError(data.error || 'Checkout failed');
        }
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignupAndSubscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!name.trim() || !email.trim() || !password.trim()) {
      setError("All fields are required");
      setLoading(false);
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters long");
      setLoading(false);
      return;
    }

    try {
      // Create account using UserContext signup function
      const signupResult = await signup(name.trim(), email.trim(), password);

      if (!signupResult.success) {
        setError(signupResult.error || 'Account creation failed');
        setLoading(false);
        return;
      }

      // Account created successfully and user is now logged in
      // Now create subscription
      const isDev = process.env.NODE_ENV === 'development';
      console.log("[signup+subscribe] === FLOW DEBUG ===");
      console.log("[signup+subscribe] NODE_ENV:", process.env.NODE_ENV);
      console.log("[signup+subscribe] isDev:", isDev);
      console.log("[signup+subscribe] Selected flow:", isDev ? "DEV (direct)" : "PROD (Stripe)");
      
      if (isDev) {
        // Existing dev flow - unchanged
        const subscriptionResponse = await fetch('/api/subscription/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 'basic' }),
          credentials: 'include',
        });

        if (subscriptionResponse.ok) {
          await Promise.all([refreshCredits(), refreshSubscription()]);
          router.push('/');
        } else {
          const subscriptionData = await subscriptionResponse.json();
          setError(subscriptionData.error || 'Subscription setup failed');
        }
      } else {
        // Production Stripe flow
        const subscriptionResponse = await fetch('/api/checkout/subscription', {
          method: 'POST',
          credentials: 'include',
        });

        if (subscriptionResponse.ok) {
          const { checkoutUrl } = await subscriptionResponse.json();
          window.location.href = checkoutUrl;
        } else {
          const subscriptionData = await subscriptionResponse.json();
          setError(subscriptionData.error || 'Checkout failed');
        }
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const isCurrentlySubscribed = subscription.plan === 'basic' && subscription.isActive;

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
          <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold mb-2">Basic Subscription</h1>
          <p className="text-zinc-400">
            Regular access to timeline excavation with monthly credits
          </p>
        </div>

        {isCurrentlySubscribed && (
          <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-lg p-4 mb-6">
            <div className="flex items-center gap-2 text-emerald-400 mb-2">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="font-medium">Already Subscribed</span>
            </div>
            <p className="text-sm text-emerald-100">
              You're currently subscribed to Basic. Your subscription renews monthly.
            </p>
            {subscription.cycleEnd && (
              <p className="text-xs text-emerald-200 mt-2">
                Next billing: {new Date(subscription.cycleEnd).toLocaleDateString()}
              </p>
            )}
          </div>
        )}

        <div className="bg-gradient-to-br from-zinc-800 to-zinc-700 border border-zinc-600 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold text-lg">Basic Plan</h3>
              <p className="text-sm text-zinc-300">Perfect for regular users</p>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold">$12</div>
              <div className="text-sm text-zinc-400">/month</div>
            </div>
          </div>

          <div className="space-y-2 mb-4">
            <div className="flex items-center gap-2 text-sm">
              <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              <span>4 unlock credits per month</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              <span>Credits roll over if unused</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              <span>Cancel anytime</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              <span>Access to all excavation features</span>
            </div>
          </div>

          {user && (
            <div className="pt-3 border-t border-zinc-600 text-xs text-zinc-400">
              Current balance: {credits} credit{credits !== 1 ? 's' : ''}
            </div>
          )}
        </div>

        <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2 text-blue-300 mb-2">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="font-medium">Great Value</span>
          </div>
          <p className="text-sm text-blue-100">
            Save $4 vs. buying individual unlocks. Perfect if you excavate 3+ accounts per month.
          </p>
        </div>

        {!user && (
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 mb-6">
            <div className="flex items-center gap-2 text-white mb-3">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="font-medium">Create Account & Subscribe</span>
            </div>
            <p className="text-sm text-zinc-400 mb-4">
              Create your account and start your subscription in one step.
            </p>
            
            <form onSubmit={handleSignupAndSubscribe} className="space-y-3">
              <div>
                <input
                  type="text"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={loading}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
                  required
                />
              </div>
              <div>
                <input
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
                  required
                />
              </div>
              <div>
                <input
                  type="password"
                  placeholder="Password (6+ characters)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
                  minLength={6}
                  required
                />
              </div>
              
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold py-3 px-6 rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Creating Account & Subscribing...' : 'Create Account & Subscribe for $12/month'}
                </button>
              </div>
            </form>
            
            <div className="mt-4 pt-3 border-t border-zinc-700 text-center">
              <p className="text-xs text-zinc-500 mb-2">Already have an account?</p>
              <Link
                href="/login"
                className="text-sm text-blue-400 hover:text-blue-300 underline"
              >
                Sign in to upgrade
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

        {user && (
          <button
            onClick={handleSubscribe}
            disabled={loading || !user || isCurrentlySubscribed}
            className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold py-3 px-6 rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading 
              ? 'Processing...' 
              : isCurrentlySubscribed 
                ? 'Already Subscribed' 
                : 'Subscribe for $12/month'
            }
          </button>
        )}

        <div className="mt-4 text-center text-xs text-zinc-500">
          <p>🔒 Secure payment processing</p>
          <p className="mt-1">Cancel anytime • No long-term commitment</p>
        </div>
      </div>

      <div className="mt-8 text-center">
        <p className="text-sm text-zinc-400 mb-3">
          Just need one unlock? No problem.
        </p>
        <Link
          href="/account/credits"
          className="inline-flex items-center gap-2 text-white hover:text-zinc-300 underline text-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          Buy single unlock for $4
        </Link>
      </div>
    </main>
  );
}