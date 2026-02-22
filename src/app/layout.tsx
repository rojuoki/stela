import type { Metadata } from "next";
import "./globals.css";

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
        {children}
        {DevPanel && <DevPanel />}
      </body>
    </html>
  );
}
