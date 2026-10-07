import type { Metadata, Viewport } from "next";
import { Roboto, Roboto_Slab } from "next/font/google";
import RegisterSW from "@/components/pwa/RegisterSW";
import OfflineManager from "@/components/pwa/OfflineManager";
import AccountSync from "@/components/account/AccountSync";
import SignInPrompt from "@/components/account/SignInPrompt";
import "./globals.css";

const roboto = Roboto({
  variable: "--font-roboto",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const robotoSlab = Roboto_Slab({
  variable: "--font-roboto-slab",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "AnimeTest123 — Zoko Anime",
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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${roboto.variable} ${robotoSlab.variable} antialiased bg-black text-white`}>
        {children}
        <RegisterSW />
        <OfflineManager />
        <AccountSync />
        <SignInPrompt />
      </body>
    </html>
  );
}
