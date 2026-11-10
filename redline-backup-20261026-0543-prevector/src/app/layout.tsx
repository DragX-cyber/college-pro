import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "REDLINE — AI Red Team Operations",
  description:
    "Autonomous red-team platform: charter-scoped guards, three operating modes (GUARDED / FREE TERMINAL / UNRESTRICTED), smart tool marketplace, honeypot detection and low-footprint engagements. Local models + API keys.",
  icons: { icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg" },
};

export const viewport: Viewport = {
  themeColor: "#05070d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* apply the saved theme before first paint — no dark flash on reload */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('redline.theme');if(t==='light')document.documentElement.classList.remove('dark');else document.documentElement.classList.add('dark')}catch(e){document.documentElement.classList.add('dark')}",
          }}
        />
      </head>
      <body className="antialiased bg-background text-foreground cyber-grid cyber-scanlines" suppressHydrationWarning>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
