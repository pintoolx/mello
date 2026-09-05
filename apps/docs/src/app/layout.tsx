import type { Metadata } from "next";
import { Noto_Sans_TC } from "next/font/google";
import "./globals.css";

const body = Noto_Sans_TC({
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
export const metadata: Metadata = {
  title: { default: "Mello 文件", template: "%s · Mello 文件" },
  description: "Mello 企業代理採購的概念、操作、政策與技術文件。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant" className={body.variable}>
      <body>{children}</body>
    </html>
  );
}
