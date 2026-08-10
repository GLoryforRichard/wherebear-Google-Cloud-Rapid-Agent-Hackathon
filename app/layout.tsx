import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import StaleClientGuard from "@/components/StaleClientGuard";
import QueueBoot from "@/components/QueueBoot";
import GlobalScanIndicator from "@/components/GlobalScanIndicator";

// Uber-adjacent geometric sans (Plus Jakarta Sans ≈ Uber Move feel).
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  title: "找货熊 Wherebear — Ask the bear. Find the aisle.",
  description: "找货熊 Wherebear helps grocery workers answer customer questions instantly.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${jakarta.variable} h-full`}>
      <body className="min-h-full" style={{ fontFamily: 'var(--font-jakarta), -apple-system, system-ui, sans-serif' }}>
        <StaleClientGuard />
        <QueueBoot />
        {children}
        <GlobalScanIndicator />
      </body>
    </html>
  );
}
