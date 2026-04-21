import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ivoreel — AI Reel Composer",
  description: "Generate 1080×1920 faceless Reels from a script.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
