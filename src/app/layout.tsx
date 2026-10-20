import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { IoSessionProvider } from "@/components/io/session";
import { IoNavigation } from "@/components/io/navigation";
import { IoFooter } from "@/components/io/footer";

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
      <body className={`flex min-h-screen flex-col bg-black text-white antialiased ${GeistSans.variable} ${GeistMono.variable} font-sans`}>
        <IoSessionProvider>
          <IoNavigation />
          <div className="flex-1">{children}</div>
          <IoFooter />
        </IoSessionProvider>
      </body>
    </html>
  );
}
