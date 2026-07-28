import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic, Readex_Pro } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { PersistenceProvider } from "@/lib/persistence";
import { SessionProvider } from "@/lib/session-store";

const readex = Readex_Pro({
  variable: "--font-readex",
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const plexArabic = IBM_Plex_Sans_Arabic({
  variable: "--font-plex-arabic",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "مدى — طبقة ذكاء رقيقة بجانب المعالج",
  description:
    "طبقة ذكاء رقيقة بجانب المعالج — توثيق الجلسة، تقرير سريري بختم الطبيب، ونشرة منزلية للمريض.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${readex.variable} ${plexArabic.variable}`}
    >
      <body>
        <SessionProvider>
          <PersistenceProvider>
            <ToastProvider>{children}</ToastProvider>
          </PersistenceProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
