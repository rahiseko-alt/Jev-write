import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Proofee",
  description: "書いた文章の裏付けの弱い箇所を、根拠と数値で知らせます。文章は書き換えません。",
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
