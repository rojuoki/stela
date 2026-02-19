import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "STELA — Unlock the earliest posts",
  description: "Instantly view the earliest 100 posts of any public X account.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
