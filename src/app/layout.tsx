import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Roblox Trends",
  description: "Explore Roblox genre momentum, player counts, and historical coverage.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
