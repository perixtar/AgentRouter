import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  weight: ["300", "400", "500", "600", "700"]
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  weight: ["400", "500", "600"]
});

export const metadata: Metadata = {
  title: "AgentRouter — control plane",
  description: "Run coding agents in isolated sandboxes on your own provider key."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" data-accent="green">
      <body
        className={`${geist.variable} ${geistMono.variable}`}
        style={
          {
            "--font-sans":
              "var(--font-geist-sans), 'SF Pro Text', system-ui, -apple-system, sans-serif",
            "--font-mono":
              "var(--font-geist-mono), 'SF Mono', ui-monospace, Menlo, monospace"
          } as React.CSSProperties
        }
      >
        {children}
      </body>
    </html>
  );
}
