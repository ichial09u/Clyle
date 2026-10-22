import type { Metadata, Viewport } from "next";
import RegisterSW from "@/components/pwa/RegisterSW";
import OfflineManager from "@/components/pwa/OfflineManager";
import AccountSync from "@/components/account/AccountSync";
import SignInPrompt from "@/components/account/SignInPrompt";
import PresenceHeartbeat from "@/components/anime/PresenceHeartbeat";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clyle — Anime, everywhere",
  description:
    "Anime catalog powered by the MyAnimeList (Jikan) API with playback through Zoko's player. New anime and episodes are imported automatically.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "Clyle", // the installed-app name on iOS home screens
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  // REQUIRED for every env(safe-area-inset-*) in the app to report real
  // values on notched devices (black-translucent status bar + standalone)
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="antialiased bg-black text-white">
        {children}
        <RegisterSW />
        <OfflineManager />
        <AccountSync />
        <SignInPrompt />
        <PresenceHeartbeat />
      </body>
    </html>
  );
}
