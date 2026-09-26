import type { Metadata } from "next";
import { Chakra_Petch, Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** Display face for panel titles and the four vitals: squared terminals, a slight lean. */
const chakra = Chakra_Petch({
  variable: "--font-chakra",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

/** Seven-segment numerals (DSEG7 Classic, SIL OFL). Self-hosted so the CSP stays font-src 'self'. */
const dseg = localFont({
  variable: "--font-dseg",
  src: [
    { path: "./fonts/DSEG7Classic-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/DSEG7Classic-Bold.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
});

export const metadata: Metadata = {
  title: "System Monitor",
  description: "Lightweight macOS system monitor",
};

/**
 * Applies the stored theme and retro level before first paint so there is no
 * flash. Runs inline (the CSP permits 'unsafe-inline' scripts for Next's own
 * bootstrap). Storage may be unavailable; every read is guarded.
 */
const BOOTSTRAP = `(function(){var d=document.documentElement;try{var q=new URLSearchParams(location.search);var t=q.get("theme")||localStorage.getItem("sm:theme");if(t==="light"||t==="dark"){d.dataset.theme=t}var r=q.get("retro")||localStorage.getItem("sm:retro");if(r==="0"||r==="1"||r==="2"){d.dataset.retro=r}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-retro="1"
      className={`${geistSans.variable} ${geistMono.variable} ${chakra.variable} ${dseg.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOTSTRAP }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
