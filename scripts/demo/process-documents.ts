/**
 * デモ書類を実際の読取処理（src/lib/extraction/pipeline.ts）にかけ、結果を demo/results/<ID>.json に保存する。
 *   npm run demo:process
 * デモ環境の書類は、この結果を「事前に処理した結果」（is_precomputed）として読み込む。画面にもその旨を表示する。
 * 結果には処理した日時・方式（OCR エンジン・ルール抽出/LLM）を記録する。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectFileType } from "../../src/lib/extraction/file-type";
import { analyzePages, readDocument } from "../../src/lib/extraction/pipeline";
import { CATALOG } from "./catalog";

const ROOT = path.resolve(import.meta.dirname, "../..");

async function main() {
  const only = process.argv.slice(2);
  await mkdir(path.join(ROOT, "demo/results"), { recursive: true });
  for (const d of CATALOG) {
    if (only.length && !only.includes(d.id)) continue;
    const bytes = await readFile(path.join(ROOT, "demo/documents", d.filename));
    const fileType = detectFileType(bytes);
    if (!fileType) throw new Error(`形式が不明：${d.filename}`);
    const started = Date.now();
    const read = await readDocument(bytes, fileType);
    const analyzed = await analyzePages(read.pages, { lastAttempt: true });
    const result = {
      id: d.id,
      filename: d.filename,
      processed_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      method: analyzed.method,
      ocr_engine: read.pages.find((p) => p.source === "ocr")?.engine ?? null,
      llm: analyzed.llm,
      pages: read.pages,
      preview: read.preview ? { width: read.preview.width, height: read.preview.height } : null,
      output: analyzed.output,
      usage: [...read.usage, ...analyzed.usage],
    };
    await writeFile(path.join(ROOT, "demo/results", `${d.id}.json`), JSON.stringify(result) + "\n");
    const filled = analyzed.output.fields.filter((f) => f.value !== null).length;
    console.log(`${d.id} ${analyzed.output.documentType.padEnd(13)} ${analyzed.method.padEnd(15)} 項目 ${filled}/${analyzed.output.fields.length} ${result.duration_ms}ms`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
