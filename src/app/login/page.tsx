"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@/contexts/UserContext";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { user, login } = useUser();

  // Redirect if already logged in
  useEffect(() => {
    if (user) {
      router.push("/");
    }
  }, [user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await login(email, password);

      if (result.success) {
        // Successful login - redirect to home
        router.push("/");
      } else {
        setError(result.error || "Login failed");
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="max-w-md mx-auto px-4 py-12">
      {/* Header */}
      <div className="text-center mb-8">
        <Link href="/" className="text-2xl font-bold mb-1 tracking-tight hover:text-zinc-300 transition-colors">
          STELA
        </Link>
        <p className="text-zinc-500 text-sm mt-2">
          Sign in to your account
        </p>
      </div>

      {/* Login Form */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-zinc-300 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-500 disabled:opacity-50"
              placeholder="your@email.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-zinc-300 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-500 disabled:opacity-50"
              placeholder="Password"
            />
          </div>

          {error && (
            <div className="p-3 bg-red-900/20 border border-red-800/50 rounded-lg">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full bg-white text-black font-semibold py-2 px-4 rounded-lg hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-zinc-400 text-sm">
            Don't have an account?{" "}
            <Link href="/signup" className="text-white hover:text-zinc-300 transition-colors font-medium">
              Sign up
            </Link>
          </p>
        </div>
      </div>

      {/* Back to Home */}
      <div className="text-center mt-8">
        <Link href="/" className="text-zinc-500 hover:text-zinc-300 transition-colors text-sm">
          ← Back to STELA
        </Link>
      </div>
    </main>
  );
}