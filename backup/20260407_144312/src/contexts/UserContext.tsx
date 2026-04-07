"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface UserSubscription {
  plan: 'free' | 'basic';
  isActive: boolean;
  cycleEnd?: string;
  creditsPerCycle?: number;
}

interface UserContextType {
  user: User | null;
  loading: boolean;
  credits: number;
  subscription: UserSubscription;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signup: (name: string, email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshCredits: () => Promise<void>;
  refreshSubscription: () => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}

interface UserProviderProps {
  children: ReactNode;
}

export function UserProvider({ children }: UserProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [credits, setCredits] = useState(0);
  const [subscription, setSubscription] = useState<UserSubscription>({
    plan: 'free',
    isActive: false,
  });

  // Check if user is logged in on mount
  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'include', // Include cookies
      });

      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        // Also fetch credits and subscription for authenticated users
        await Promise.all([fetchCredits(), fetchSubscription()]);
      } else {
        setUser(null);
        setCredits(0);
        setSubscription({ plan: 'free', isActive: false });
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      setUser(null);
      setCredits(0);
      setSubscription({ plan: 'free', isActive: false });
    } finally {
      setLoading(false);
    }
  };

  const fetchCredits = async () => {
    try {
      const response = await fetch('/api/credits', {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setCredits(data.balance || 0);
      }
    } catch (error) {
      console.error('Credits fetch failed:', error);
    }
  };

  const fetchSubscription = async () => {
    try {
      const response = await fetch('/api/subscription', {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setSubscription({
          plan: data.plan || 'free',
          isActive: data.isActive || false,
          cycleEnd: data.cycleEnd,
          creditsPerCycle: data.creditsPerCycle,
        });
      } else {
        setSubscription({ plan: 'free', isActive: false });
      }
    } catch (error) {
      console.error('Subscription fetch failed:', error);
      setSubscription({ plan: 'free', isActive: false });
    }
  };

  const login = async (email: string, password: string) => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      });

      const data = await response.json();

      if (response.ok) {
        setUser(data.user);
        await Promise.all([fetchCredits(), fetchSubscription()]);
        return { success: true };
      } else {
        return { success: false, error: data.error || 'Login failed' };
      }
    } catch (error) {
      return { success: false, error: 'Network error' };
    }
  };

  const signup = async (name: string, email: string, password: string) => {
    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, email, password }),
        credentials: 'include',
      });

      const data = await response.json();

      if (response.ok) {
        setUser(data.user);
        await Promise.all([fetchCredits(), fetchSubscription()]);
        return { success: true };
      } else {
        return { success: false, error: data.error || 'Signup failed' };
      }
    } catch (error) {
      return { success: false, error: 'Network error' };
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      setUser(null);
      setCredits(0);
      setSubscription({ plan: 'free', isActive: false });
    }
  };

  const refreshCredits = async () => {
    if (user) {
      await fetchCredits();
    }
  };

  const refreshSubscription = async () => {
    if (user) {
      await fetchSubscription();
    }
  };

  const value: UserContextType = {
    user,
    loading,
    credits,
    subscription,
    login,
    signup,
    logout,
    refreshCredits,
    refreshSubscription,
  };

  return (
    <UserContext.Provider value={value}>
      {children}
    </UserContext.Provider>
  );
}