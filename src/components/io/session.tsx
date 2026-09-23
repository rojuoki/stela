"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
type User = { id: string; name: string; email: string };
const Session = createContext<{ user: User | null; loading: boolean; error: string; refresh: () => Promise<void> }>({ user: null, loading: true, error: "", refresh: async () => {} });
export function IoSessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/io/auth/me", { cache: "no-store" });
      if (response.status === 401) { setUser(null); setError(""); return; }
      if (!response.ok) throw new Error("ログイン状態を確認できません。再読み込みしてください。");
      const data = await response.json(); setUser(data.user); setError("");
    } catch (e) { setUser(null); setError(e instanceof Error ? e.message : "接続できません"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <Session.Provider value={{ user, loading, error, refresh }}>{children}</Session.Provider>;
}
export const useIoSession = () => useContext(Session);
