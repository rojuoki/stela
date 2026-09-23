import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { IoSessionProvider } from "@/components/io/session";
import { IoNavigation } from "@/components/io/navigation";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "STELA — Unlock the earliest posts",
  description: "Unlock and explore the earliest posts of public X accounts.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`bg-black text-white min-h-screen antialiased ${geist.variable} ${geistMono.variable} font-sans`}>
        <IoSessionProvider>
          <IoNavigation />
          {children}
        </IoSessionProvider>
      </body>
    </html>
  );
}
