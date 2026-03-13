import type { Metadata } from "next";
import "./globals.css";
import { UserProvider } from "@/contexts/UserContext";
import { NavBar } from "@/components/NavBar";

export const metadata: Metadata = {
  title: "STELA — Unlock the earliest posts",
  description: "Instantly view the earliest 100 posts of any public X account.",
};

const DevPanel =
  process.env.NEXT_PUBLIC_DEV_PANEL === "1"
    ? (await import("@/dev/DevPanel")).default
    : null;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white min-h-screen antialiased">
        <UserProvider>
          <NavBar />
          {children}
        </UserProvider>
        {DevPanel && <DevPanel />}
      </body>
    </html>
  );
}
