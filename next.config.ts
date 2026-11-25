import type { NextConfig } from "next";

/** すべての応答に付けるセキュリティヘッダー（CSP はリクエストごとの nonce が要るため src/proxy.ts で付ける） */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const OCR_FILES = [
  "./node_modules/tesseract.js/**/*",
  "./node_modules/tesseract.js-core/**/*",
  "./node_modules/@tesseract.js-data/jpn/4.0.0/**/*",
  "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/**/*",
  "./node_modules/{bmp-js,is-url,node-fetch,regenerator-runtime,wasm-feature-detect,zlibjs,idb-keyval,whatwg-url,tr46,webidl-conversions}/**/*",
  "./node_modules/pdfjs-dist/legacy/build/**/*",
  "./node_modules/pdfjs-dist/cmaps/**/*",
  "./node_modules/pdfjs-dist/standard_fonts/**/*",
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // 読取（PDF の解析・画像の変換・OCR）はサーバーの Node.js でそのまま動かす（バンドルしない）
  serverExternalPackages: ["pdfjs-dist", "tesseract.js", "tesseract.js-core", "@napi-rs/canvas", "sharp"],
  // OCR の学習データ・WebAssembly・pdf.js の文字の対応表は動的に読み込むため、読取を動かす API の関数に明示して含める
  outputFileTracingIncludes: {
    "/api/**": OCR_FILES,
  },
  experimental: {
    // アップロード（1ファイルずつ送る）を proxy が途中で切らないように
    proxyClientMaxBodySize: "21mb",
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
