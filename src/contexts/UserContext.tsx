"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

export interface User {
  id: string;
  email: string;
  name: string;
}

interface UserContextType {
  user: User | null;
  loading: boolean;
  credits: number;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signup: (name: string, email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshCredits: () => Promise<void>;
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
        // Also fetch credits for authenticated users
        await fetchCredits();
      } else {
        setUser(null);
        setCredits(0);
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      setUser(null);
      setCredits(0);
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
        await fetchCredits();
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
        await fetchCredits();
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
    }
  };

  const refreshCredits = async () => {
    if (user) {
      await fetchCredits();
    }
  };

  const value: UserContextType = {
    user,
    loading,
    credits,
    login,
    signup,
    logout,
    refreshCredits,
  };

  return (
    <UserContext.Provider value={value}>
      {children}
    </UserContext.Provider>
  );
}