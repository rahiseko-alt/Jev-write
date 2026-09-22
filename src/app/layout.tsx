import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jev-write | 文章品質保証システム",
  description: "事実確認・AI表現検査・安全修正。JEV原子判定と事実台帳でハルシネーションを防ぎ、自然な日本語へ推敲します。",
  keywords: [
    "ファクトチェック",
    "文章校正",
    "AI文章検査",
    "Jev-write",
    "事実確認",
    "ハルシネーション防止",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className="scroll-smooth">
      <body className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 selection:bg-blue-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
