"use client";

import Link from "next/link";
import { useUser } from "@/contexts/UserContext";
import { useState, useRef, useEffect } from "react";

export function NavBar() {
  const { user, loading, credits, logout } = useUser();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleLogout = async () => {
    await logout();
    setUserMenuOpen(false);
  };

  return (
    <nav className="border-b border-zinc-800 bg-black/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="text-xl font-bold tracking-tight hover:text-zinc-300 transition-colors">
            STELA
          </Link>

          {/* User Section */}
          <div className="flex items-center gap-4">
            {loading ? (
              // Loading state
              <div className="w-8 h-8 bg-zinc-800 rounded-full animate-pulse" />
            ) : user ? (
              // Authenticated user
              <div className="flex items-center gap-3">
                {/* Credits Display */}
                <div className="hidden sm:flex items-center gap-2 text-sm text-zinc-400">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
                  </svg>
                  <span className="font-medium text-zinc-200">{credits}</span>
                  <span>credits</span>
                </div>

                {/* User Menu */}
                <div className="relative" ref={menuRef}>
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="flex items-center gap-2 text-sm bg-zinc-900 hover:bg-zinc-800 px-3 py-2 rounded-lg transition-colors"
                  >
                    <div className="w-6 h-6 bg-gradient-to-br from-blue-400 to-purple-500 rounded-full flex items-center justify-center text-xs font-semibold text-white">
                      {user.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="hidden sm:block font-medium">{user.name}</span>
                    <svg 
                      className={`w-4 h-4 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`}
                      fill="none" 
                      viewBox="0 0 24 24" 
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {userMenuOpen && (
                    <div className="absolute right-0 mt-2 w-48 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1 z-10">
                      <div className="px-4 py-2 border-b border-zinc-800">
                        <p className="text-sm font-medium">{user.name}</p>
                        <p className="text-xs text-zinc-400">{user.email}</p>
                      </div>
                      
                      {/* Mobile credits display */}
                      <div className="sm:hidden px-4 py-2 border-b border-zinc-800">
                        <div className="flex items-center gap-2 text-sm text-zinc-400">
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8.07 7.949 8.433 7.418zM11 12.849v-1.698c.22.071.412.164.567.267.364.532.364.923 0 1.464-.155.103-.346.196-.567.267z" />
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6.102 7.036 6.102 8c0 .964.5 1.766 1.222 2.246.135.09.288.171.448.245.02.009.039.018.059.027.951.409 1.969.909 1.969 2.482 0 .964-.5 1.766-1.222 2.246-.135.09-.288.171-.448.245-.02.009-.039.018-.059.027-.951.409-1.969.909-1.969 2.482a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 13.898 12.964 13.898 12c0-.964-.5-1.766-1.222-2.246a4.025 4.025 0 00-.448-.245 1.015 1.015 0 01-.059-.027C11.218 9.073 10.2 8.573 10.2 7c0-.964.5-1.766 1.222-2.246.135-.09.288-.171.448-.245.02-.009.039-.018.059-.027.351-.151.724-.297 1.071-.462V5a1 1 0 102 0z" clipRule="evenodd" />
                          </svg>
                          <span className="font-medium">{credits} credits</span>
                        </div>
                      </div>

                      <Link
                        href="/account"
                        className="block w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                          Account Dashboard
                        </div>
                      </Link>

                      <Link
                        href="/account/unlocks"
                        className="block w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          My Unlocks
                        </div>
                      </Link>

                      <button
                        onClick={handleLogout}
                        className="block w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                          </svg>
                          Sign Out
                        </div>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              // Guest user
              <div className="flex items-center gap-3">
                <Link
                  href="/login"
                  className="text-sm text-zinc-300 hover:text-white transition-colors"
                >
                  Sign In
                </Link>
                <Link
                  href="/signup"
                  className="text-sm bg-white text-black font-semibold px-4 py-2 rounded-lg hover:bg-zinc-200 transition-colors"
                >
                  Sign Up
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}