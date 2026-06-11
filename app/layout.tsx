import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";
import StaleClientGuard from "@/components/StaleClientGuard";

// Wherebear 3.0 "Gumroad" direction — Space Grotesk (geometric, neo-brutalist).
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space",
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
    <html lang="en" className={`${spaceGrotesk.variable} h-full`}>
      <body className="min-h-full" style={{ fontFamily: 'var(--font-space), -apple-system, system-ui, sans-serif' }}>
        <StaleClientGuard />
        {children}
      </body>
    </html>
  );
}
