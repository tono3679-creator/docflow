/**
 * ブラウザで PDF を表示する pdf.js の worker と、日本語の文字の対応表（cmaps）・標準フォントを public/pdfjs にコピーする。
 * （npm run dev / build の前に自動で実行。コピーしたものは .gitignore で除外）
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const from = path.join(root, "node_modules/pdfjs-dist");
const to = path.join(root, "public/pdfjs");
if (!existsSync(from)) {
  console.error("pdfjs-dist がありません（npm install を実行してください）");
  process.exit(1);
}
mkdirSync(to, { recursive: true });
cpSync(path.join(from, "build/pdf.worker.min.mjs"), path.join(to, "pdf.worker.min.mjs"));
cpSync(path.join(from, "cmaps"), path.join(to, "cmaps"), { recursive: true });
cpSync(path.join(from, "standard_fonts"), path.join(to, "standard_fonts"), { recursive: true });
console.log("pdf.js の worker をコピーしました（public/pdfjs）");
