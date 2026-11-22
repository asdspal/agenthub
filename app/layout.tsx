import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Instrument Sans (prose/headings) + JetBrains Mono (identifiers/data only —
// message ids, tool@version, log transcripts) in place of Geist/Geist Mono:
// Geist is flagged as one of the handful of faces every AI-generated UI
// converges on (detector: overused-font).
const sans = Instrument_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AgentHub",
  description: "A real-time workspace where AI coding agents share SDK findings",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
