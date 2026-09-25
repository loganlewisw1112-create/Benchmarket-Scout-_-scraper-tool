import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import SiteFooter from "@/components/SiteFooter";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// metadataBase comes from lib/site.ts (NEXT_PUBLIC_SITE_URL, defaulting to
// the primary domain), so canonical and social image URLs are absolute to the
// primary host even when served from a secondary Vercel domain. Canonical
// links are set per page (a root-level canonical would be inherited by every
// route and point them all at the home page).
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  openGraph: {
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    siteName: SITE_NAME,
    type: "website",
  },
  twitter: {
    // Large card so shared links preview with the 1200x630 opengraph-image.png
    // in this segment (file-based, so it is not repeated here). X falls back
    // to og:image when twitter:image is unset.
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
};

// Light-only UI (see globals.css): emits <meta name="color-scheme">.
export const viewport: Viewport = {
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // suppressHydrationWarning stays on <html>/<body> only: browser extensions
  // commonly inject attributes there before hydration. It does not reach
  // descendants, so mismatches inside the app still warn.
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <div className="flex-1">{children}</div>
        <SiteFooter />
        {/* Cookieless page analytics. Disclosed on /privacy — keep the two in
            sync if this ever collects more than anonymous page views. */}
        <Analytics />
      </body>
    </html>
  );
}
