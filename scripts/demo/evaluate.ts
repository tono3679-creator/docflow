/**
 * 読取精度の測定。demo/results（実際の処理結果）を demo/ground-truth.json（書類に印字した値）と比べる。
 *   npm run demo:evaluate            → 集計を表示し、docs/ACCURACY.md を書き出す
 *   npm run demo:evaluate -- --detail → 間違えた項目も表示
 * 数えるもの：書類種別の正解数／項目（正解が印字されている項目）の正解・誤り・未取得／
 *            印字されていないのに値を入れた件数（推測で埋めていないかの確認）／明細の値の正解数
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compactKey } from "../../src/lib/extraction/text";
import type { DocumentContext, DocumentType, SourceRef } from "../../src/lib/extraction/types";
import { validateDocument } from "../../src/lib/validation/validate";

const ROOT = path.resolve(import.meta.dirname, "../..");
const detail = process.argv.includes("--detail");

type Truth = { id: string; filename: string; pattern: string; render: string; document_type: string; fields: Record<string, string | null>; lines: Record<string, string | null>[] };
type RField = { key: string; line: number | null; value: string | null; source: SourceRef | null; conflicts?: { value: string }[] };
type Result = { id: string; method: string; output: { documentType: DocumentType; fields: RField[]; context: DocumentContext } };

/** 画面と同じ検証（信頼度 0.8 未満・原本の位置なし・形式・金額の照合・矛盾）で、項目が「要確認・不整合」になるか */
function flaggedKeys(r: Result): Set<string> {
  const ref = (f: { key: string; line: number | null }) => `${f.line ?? "h"}:${f.key}`;
  const conflicts: Record<string, string[]> = {};
  for (const f of r.output.fields) if (f.conflicts?.length) conflicts[f.line === null ? f.key : `line.${f.line}.${f.key}`] = f.conflicts.map((c) => c.value);
  const v = validateDocument({
    documentType: r.output.documentType,
    fields: r.output.fields.map((f) => ({ id: ref(f), key: f.key, line: f.line, value: f.value, hasSource: !!f.source, conf: f.source?.conf ?? null, source: r.method.startsWith("ocr") ? "ocr" : "pdf_text", reviewStatus: "unreviewed" })),
    conflicts,
    context: r.output.context,
    threshold: 0.8,
    duplicates: [],
    accepted: {},
  });
  return new Set(v.fieldStatuses.filter((s) => s.status === "needs_review" || s.status === "inconsistent").map((s) => s.id));
}

const same = (a: string | null, b: string | null) => a !== null && b !== null && compactKey(a) === compactKey(b);

async function main() {
  const truth: Truth[] = JSON.parse(await readFile(path.join(ROOT, "demo/ground-truth.json"), "utf8"));
  let typeOk = 0;
  const f = { total: 0, correct: 0, wrong: 0, missing: 0, invented: 0, located: 0, wrongFlagged: 0, correctFlagged: 0 };
  const l = { total: 0, correct: 0 };
  const byRender = new Map<string, { total: number; correct: number }>();
  const rows: string[] = [];
  for (const t of truth) {
    const r: Result = JSON.parse(await readFile(path.join(ROOT, "demo/results", `${t.id}.json`), "utf8"));
    if (r.output.documentType === t.document_type) typeOk++;
    const header = new Map(r.output.fields.filter((x) => x.line === null).map((x) => [x.key, x]));
    const flagged = flaggedKeys(r);
    let dc = 0, dt = 0;
    for (const [key, expected] of Object.entries(t.fields)) {
      const got = header.get(key);
      if (expected === null) {
        if (got?.value) {
          f.invented++;
          if (detail) rows.push(`  ${t.id} ${key}: 印字なし → 「${got.value}」`);
        }
        continue;
      }
      f.total++;
      dt++;
      if (!got || got.value === null) {
        f.missing++;
        if (detail) rows.push(`  ${t.id} ${key}: 未取得（正解 ${expected}）`);
      } else if (same(got.value, expected)) {
        f.correct++;
        dc++;
        if (got.source) f.located++;
        if (flagged.has(`h:${key}`)) f.correctFlagged++;
      } else {
        f.wrong++;
        const isFlagged = flagged.has(`h:${key}`);
        if (isFlagged) f.wrongFlagged++;
        if (detail) rows.push(`  ${t.id} ${key}: 「${got.value}」（正解 ${expected}）${isFlagged ? "" : " ※要確認にならない"}`);
      }
    }
    const lines = r.output.fields.filter((x) => x.line !== null);
    // 対象外の書類（見積書など）は項目を取り出さないので、明細も数えない
    if (t.document_type !== "unknown") t.lines.forEach((line, i) => {
      for (const [key, expected] of Object.entries(line)) {
        if (expected === null) continue;
        l.total++;
        const got = lines.find((x) => x.line === i && x.key === key);
        if (got && same(got.value, expected)) l.correct++;
        else if (detail) rows.push(`  ${t.id} 明細${i + 1}.${key}: 「${got?.value ?? "未取得"}」（正解 ${expected}）`);
      }
    });
    const b = byRender.get(t.render) ?? { total: 0, correct: 0 };
    b.total += dt;
    b.correct += dc;
    byRender.set(t.render, b);
  }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  const lines = [
    `# 読取精度の測定結果`,
    ``,
    `測定日：${new Date().toISOString().slice(0, 10)}／方式：demo/results に記録した方式（ルール抽出＋PDF の文字情報・Tesseract OCR。LLM は未使用）`,
    `対象：架空のデモ書類 ${truth.length} 件（demo/documents。正解は印字した値 demo/ground-truth.json）`,
    ``,
    `| 指標 | 結果 |`,
    `|---|---|`,
    `| 書類種別の判定 | ${typeOk} / ${truth.length}（${pct(typeOk, truth.length)}） |`,
    `| 見出しの項目（正解が印字されている項目） | 正解 ${f.correct} / ${f.total}（${pct(f.correct, f.total)}）・誤り ${f.wrong}・未取得 ${f.missing} |`,
    `| 正解した項目のうち原本の位置を特定できた数 | ${f.located} / ${f.correct} |`,
    `| 印字されていない項目に値を入れた件数 | ${f.invented} |`,
    `| 誤りの項目のうち「要確認」「不整合」として示された数 | ${f.wrongFlagged} / ${f.wrong} |`,
    `| 正解の項目のうち「要確認」になった数（念のための確認） | ${f.correctFlagged} / ${f.correct} |`,
    `| 明細の値（品名・数量・単位・単価・金額） | 正解 ${l.correct} / ${l.total}（${pct(l.correct, l.total)}） |`,
    ``,
    `書類の形式ごとの見出し項目の正解率：`,
    ``,
    `| 形式 | 正解 / 項目数 |`,
    `|---|---|`,
    ...[...byRender.entries()].map(([k, v]) => `| ${k} | ${v.correct} / ${v.total}（${pct(v.correct, v.total)}） |`),
    ``,
    `※ 架空のデモ書類での測定です。実際の取引先の書類での精度を示すものではありません。`,
    `※ 「要確認」の判定は画面と同じ検証（OCR の信頼度 0.8 未満・原本の位置なし・形式・金額の照合・矛盾）で数えています。`,
    `※ 未取得の項目は画面で「未取得」と示します。どの項目も、人が確定するまで「処理済み」になりません（自動で確定しません）。`,
  ];
  console.log(lines.join("\n"));
  if (detail) console.log(rows.join("\n"));
  await writeFile(path.join(ROOT, "docs/ACCURACY.md"), lines.join("\n") + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
