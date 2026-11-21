import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/500.css";
import "@fontsource/noto-sans-jp/700.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "DocFlow｜AI帳票・書類処理", template: "%s | DocFlow" },
  description: "請求書・領収書・納品書を読み取り、原本と見比べて確認し、Excel・CSV に出力する。中小企業向けの書類処理システム（デモ）。",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // ページは毎回サーバーで描画する（ログイン状態で内容が変わり、CSP の nonce をスクリプトに付けるため）
  await connection();
  return (
    <html lang="ja">
      <body>
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
