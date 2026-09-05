import type { Metadata } from "next";
import { Noto_Sans_TC, Poppins, Roboto_Mono } from "next/font/google";
import "./globals.css";

const display = Poppins({ variable: "--font-display", weight: ["400", "500", "600", "700", "800"], subsets: ["latin"] });
const body = Noto_Sans_TC({ variable: "--font-body", weight: ["400", "500", "600", "700", "800"], subsets: ["latin"] });
const mono = Roboto_Mono({ variable: "--font-mono", weight: ["400", "500", "600", "700"], subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mello — Agent Purchase-to-Pay Control",
  description: "x402 解決付款。Mello 把帳做完。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-Hant" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
