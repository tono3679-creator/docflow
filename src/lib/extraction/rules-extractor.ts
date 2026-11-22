/**
 * ルールによる項目抽出（LLM を使わない方式。外部に送信しない）。
 *   1. 明細の表：見出しの行（品名・数量・単価・金額）を探し、列の位置で各行の値を振り分ける
 *   2. 見出しの項目：ラベル（「請求番号」「合計」など）の右・下にある値を、項目の形式（日付・金額・番号）で読む
 *   3. 会社名：御中・様 の付いた行＝宛先、会社らしい名前で住所・TEL の近くにある行＝発行元
 * 値は原本の文字の位置（単語の座標）と一緒に返す。見つからない項目は null（推測で埋めない）。
 * 同じ項目に違う値の記載が複数あれば conflicts に入れる（矛盾として確認に回す）。
 */
import { union } from "./geometry";
import { rangeSource, subBox, type LayoutPage } from "./layout";
import type { KnownType } from "./schema";
import { normalizeText, tidySpaces } from "./text";
import type { Box, DocumentContext, ExtractedField, Line, LineItemBox, SourceRef } from "./types";
import { parseDecimalMilli, milliToString, parseJpDate, parseRegistrationNumber, parseTaxRate, parseYen } from "../validation/values";

type LRef = { lp: LayoutPage; line: Line };
type Candidate = { value: string; raw: string; source: SourceRef | null; priority: number; strong: boolean; order: number };

// ---------------------------------------------------------------
// 値の形
// ---------------------------------------------------------------
// 桁区切りは「,」。OCR が「,」を「.」と読んだもの（「1.660」）も、3桁ずつのときは桁区切りとして読む（円に小数は無い）
const AMOUNT_RE = /(?<![\d.\-/:])(?:[△▲\-−])?¥?\s?(?:\d{1,3}(?:,\s?\d{3})+|\d{1,3}(?:\.\d{3})+(?![\d.])|\d+)(?![\d%/.:年月日])(?:\s?円)?-?/g;
const DATE_RE = /(?:\d{4}\s?[年/.\-]\s?\d{1,2}\s?[月/.\-]\s?\d{1,2}\s?日?|(?:令和|R|平成|H)\s?(?:\d{1,2}|元)\s?[年/.\-]\s?\d{1,2}\s?[月/.\-]\s?\d{1,2}\s?日?)/g;
const CODE_RE = /[A-Za-z0-9][A-Za-z0-9\-_/]{1,30}/g;
const REG_RE = /T\s?\d(?:[\s\-]?\d){12}/g;
const COMPANY_RE = /(株式会社|有限会社|合同会社|合資会社|一般社団法人|㈱|㈲|\(株\)|\(有\)|商店|商会|事務所|工業|製作所|工務店|設備|物産|商事|サービス|ストア|食堂|カフェ|喫茶|薬局|書店|運輸|電機|建設|[^支本]店$|店舗)/;
/** 日本語の文字（ラベルの語かどうかの見分けに使う） */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const PAYMENT_RE = /(現金|クレジットカード|クレジット|デビットカード|電子マネー|QRコード決済|銀行振込|口座振替|振込)/;

type Kind = "amount" | "date" | "code" | "reg_no" | "text";
const TEXT_KEYS = new Set(["issuer_name", "recipient_name", "purpose", "payment_method", "notes", "description", "unit"]);

function findValue(kind: Kind, text: string): { start: number; end: number; value: string } | null {
  const re = kind === "amount" ? AMOUNT_RE : kind === "date" ? DATE_RE : kind === "code" ? CODE_RE : kind === "reg_no" ? REG_RE : null;
  if (!re) {
    const t = text.replace(/^[\s:：]+/, "");
    if (!t.trim()) return null;
    const start = text.length - t.length;
    return { start, end: text.length, value: t.trim() };
  }
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const start = m.index + lead;
    const end = m.index + raw.trimEnd().length;
    const token = text.slice(start, end);
    if (kind === "amount") {
      // 「消費税(10%)」「(1」のような括弧の中の税率を金額と取り違えない
      if (!/^[¥△▲\-−]/.test(token) && /[(（]\s?$/.test(text.slice(0, start))) continue;
      const v = parseYen(token);
      if (v === null) continue;
      return { start, end, value: String(v) };
    }
    if (kind === "date") {
      const v = parseJpDate(token);
      return { start, end, value: v ?? token };
    }
    if (kind === "reg_no") {
      const v = parseRegistrationNumber(token);
      return { start, end, value: v ?? token.replace(/\s/g, "") };
    }
    // 番号：日本語のラベル語（No など）を除いた英数字。数字を1つ以上含むもの
    if (!/\d/.test(token)) continue;
    return { start, end, value: token };
  }
  return null;
}

function src(lp: LayoutPage, line: Line, start: number, end: number): SourceRef | null {
  const r = rangeSource(lp, line, start, end);
  if (!r) return null;
  return { page: lp.page.page, box: r.box, text: line.text.slice(start, end), conf: r.conf };
}

/**
 * ラベルを空白を除いた文字で探す（OCR は「消費 税額」のように語の間に空白を入れることがある）。
 * 位置は元の文字列の位置で返す。
 */
function matchLabel(re: RegExp, text: string): { index: number; end: number; text: string } | null {
  const map: number[] = [];
  let compact = "";
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    map.push(i);
    compact += text[i];
  }
  const m = re.exec(compact);
  if (!m || m[0].length === 0) return null;
  const index = map[m.index];
  const end = map[m.index + m[0].length - 1] + 1;
  return { index, end, text: text.slice(index, end) };
}

const compactOf = (text: string) => text.replace(/\s/g, "");

/** 値の前に日本語の語が2文字以上あれば、別のラベルの行とみなす（「消費税(10%)」の 10 を小計と読まない） */
function labelledElsewhere(text: string, start: number): boolean {
  let before = text.slice(0, start);
  // 大きな字の「¥」を OCR が日本語の1〜2文字に読み違えたもの（「ぞそ1,800-」「羊5,800」）は、ラベルの語に数えない。
  // 行の先頭から数字の直前までがその1〜2文字だけで、値が桁区切りの金額のときに限る
  if (/^\s*[^\s\d]{1,2}\s*$/.test(before) && /^\d{1,3}(,\s?\d{3})+/.test(text.slice(start))) before = "";
  return (before.match(CJK_RE)?.length ?? 0) >= 2;
}

// ---------------------------------------------------------------
// 行のまとまり
// ---------------------------------------------------------------
function rowLines(lp: LayoutPage, row: number): Line[] {
  return lp.lines.filter((l) => l.row === row).sort((a, b) => a.box.x - b.box.x);
}

/** ラベルの後ろ（同じ行の残り → 同じ段の右の行 → すぐ下の行）から値を探す */
function valueNear(lp: LayoutPage, line: Line, labelEnd: number, kind: Kind, excluded: Set<string>, below = true): { line: Line; start: number; end: number; value: string } | null {
  const rest = line.text.slice(labelEnd);
  const same = findValue(kind, rest);
  if (same && (kind !== "text" || same.value.length > 0)) return { line, start: labelEnd + same.start, end: labelEnd + same.end, value: same.value };
  const right = rowLines(lp, line.row).filter((l) => l.box.x > line.box.x + line.box.w * 0.9 && !excluded.has(l.id));
  for (const r of right) {
    const v = findValue(kind, r.text);
    if (v && kind !== "text" && labelledElsewhere(r.text, v.start)) break;
    if (v) return { line: r, ...v };
    if (kind === "text") break;
  }
  if (!below) return null;
  // 下：ラベルと横位置が重なる、近い行
  const belowLines = lp.lines
    .filter((l) => !excluded.has(l.id) && l.box.y > line.box.y + line.box.h * 0.5 && l.box.y - (line.box.y + line.box.h) < line.box.h * 2.2)
    .filter((l) => l.box.x < line.box.x + line.box.w + 0.02 && l.box.x + l.box.w > line.box.x - 0.02)
    .sort((a, b) => a.box.y - b.box.y);
  for (const b of belowLines.slice(0, 1)) {
    const v = findValue(kind, b.text);
    if (v && kind !== "text" && labelledElsewhere(b.text, v.start)) break;
    if (v) return { line: b, ...v };
  }
  return null;
}

// ---------------------------------------------------------------
// 見出しの項目のラベル（先にあるものほど優先。strong のラベルどうしで値が違えば矛盾）
// ---------------------------------------------------------------
type LabelSpec = { re: RegExp; strong?: boolean; exclude?: RegExp };
type FieldRule = { key: string; kind: Kind; labels: LabelSpec[] };

const NUMBER_EXCLUDE = /(登録番号|電話|TEL|FAX|口座|郵便|〒)/i;
const TOTAL_EXCLUDE = /(小計|対象|税抜|数量|点数|件数|明細)/;
/** 「No.」のラベル（OCR が値の前に付けた「(」「:」も許す：「No. (CM-3391」） */
const NO_LABEL = /(?<![A-Za-z])No\.?(?=[(（:：]?[A-Za-z0-9])/;

const COMMON_RULES: FieldRule[] = [
  { key: "registration_number", kind: "reg_no", labels: [{ re: /(適格請求書発行事業者)?登録番号/, strong: true }] },
  { key: "subtotal", kind: "amount", labels: [{ re: /小計/, strong: true }, { re: /税抜(金額|合計)/ }] },
  { key: "discount", kind: "amount", labels: [{ re: /(値引き?|割引)(額)?/ }] },
  { key: "shipping_fee", kind: "amount", labels: [{ re: /(送料|配送料|運賃|振込手数料|手数料)/ }] },
  { key: "tax_amount", kind: "amount", labels: [{ re: /(内)?消費税(等)?(額)?(合計)?/, strong: true, exclude: /対象/ }, { re: /税額/, exclude: /対象/ }] },
];

const RULES: Record<KnownType, FieldRule[]> = {
  invoice: [
    { key: "invoice_number", kind: "code", labels: [{ re: /請求書?(番号|No\.?)/i, strong: true, exclude: NUMBER_EXCLUDE }, { re: /Invoice\s?No\.?/i }, { re: NO_LABEL, exclude: NUMBER_EXCLUDE }] },
    { key: "issue_date", kind: "date", labels: [{ re: /(請求日|発行日|発行年月日)/, strong: true }, { re: /日付/ }] },
    { key: "due_date", kind: "date", labels: [{ re: /(お?支払(い)?期(限|日)|お?振込期(限|日)|支払予定日)/, strong: true }, { re: /お?支払い?.限/ }] },
    ...COMMON_RULES,
    { key: "total_amount", kind: "amount", labels: [{ re: /ご?請求金額/, strong: true, exclude: TOTAL_EXCLUDE }, { re: /(税込)?合計金額/, strong: true, exclude: TOTAL_EXCLUDE }, { re: /総合計/, strong: true }, { re: /合計/, strong: true, exclude: TOTAL_EXCLUDE }] },
    { key: "notes", kind: "text", labels: [{ re: /備考/ }] },
  ],
  receipt: [
    { key: "receipt_number", kind: "code", labels: [{ re: /領収書?(番号|No\.?)/i, strong: true, exclude: NUMBER_EXCLUDE }, { re: NO_LABEL, exclude: NUMBER_EXCLUDE }] },
    { key: "issue_date", kind: "date", labels: [{ re: /(発行日|領収日|発行年月日)/, strong: true }, { re: /日付/ }] },
    ...COMMON_RULES,
    { key: "total_amount", kind: "amount", labels: [{ re: /領収金額/, strong: true }, { re: /(税込)?合計(金額)?/, strong: true, exclude: TOTAL_EXCLUDE }, { re: /金額/, exclude: /(対象|税|小計)/ }] },
    { key: "payment_method", kind: "text", labels: [{ re: /(お)?支払(い)?方法/ }] },
    // 「但し書籍代として」の「書」をラベルに含めない（「但し書き」「但書」「但し書：」だけをラベルの語とみなす）
    { key: "purpose", kind: "text", labels: [{ re: /但し書き|但し書(?=[:：])|但書き?|但し/ }, { re: /^但/ }] },
  ],
  delivery_note: [
    { key: "delivery_number", kind: "code", labels: [{ re: /納品書?(番号|No\.?)/i, strong: true, exclude: NUMBER_EXCLUDE }, { re: /伝票(番号|No\.?)/ }, { re: NO_LABEL, exclude: NUMBER_EXCLUDE }] },
    { key: "delivery_date", kind: "date", labels: [{ re: /納品日/, strong: true }, { re: /(発行日|日付)/ }] },
    ...COMMON_RULES,
    { key: "total_amount", kind: "amount", labels: [{ re: /(税込)?合計金額/, strong: true, exclude: TOTAL_EXCLUDE }, { re: /総合計/, strong: true }, { re: /合計/, strong: true, exclude: TOTAL_EXCLUDE }] },
    { key: "notes", kind: "text", labels: [{ re: /備考/ }] },
  ],
};

// ---------------------------------------------------------------
// 明細の表
// ---------------------------------------------------------------
type ColKey = "description" | "quantity" | "unit" | "unit_price" | "amount" | "tax_rate";
const HEADER: Record<ColKey, RegExp> = {
  description: /(品名|品目|摘要|内容|商品名|品番・品名|項目|件名)/,
  quantity: /(数量|数)/,
  // OCR が「単」を読み違えることがある（「除位」「南価」）。見出しの行の中でだけ使うので「位」「価」の1文字で見分ける
  unit: /(単位|位)/,
  unit_price: /(単価|価(?!格))/,
  amount: /(金額|価格)/,
  tax_rate: /(税率|税区分)/,
};
// 「※」で始まる行は、軽減税率の印の付いた明細（※ 業務用コーヒー豆）と注記（※印は軽減税率）の両方がある
const TABLE_END = /^(小計|合計|計|以下余白|消費税|備考|10%対象|8%対象|お?振込先|※印?は|※(軽減|消費税|上記|お支払))/;

type Cell = { words: number[]; text: string };
type TableResult = { fields: ExtractedField[]; boxes: LineItemBox[]; usedLines: Set<string>; nextIndex: number };

function cellSource(lp: LayoutPage, cell: Cell, start = 0, end = cell.text.length): SourceRef | null {
  // cell.text は単語の文字をつないだもの（区切りなし）
  const boxes: Box[] = [];
  let conf: number | null = null;
  let pos = 0;
  for (const wi of cell.words) {
    const t = lp.normWords[wi];
    const from = Math.max(start, pos);
    const to = Math.min(end, pos + t.length);
    if (from < to) {
      const w = lp.page.words[wi];
      boxes.push(subBox(w, t, from - pos, to - pos));
      if (w.conf !== null) conf = conf === null ? w.conf : Math.min(conf, w.conf);
    }
    pos += t.length;
  }
  const box = union(boxes);
  return box ? { page: lp.page.page, box, text: cell.text.slice(start, end), conf } : null;
}

function parseTable(lp: LayoutPage, startIndex: number): TableResult | null {
  const rows = [...new Set(lp.lines.map((l) => l.row))].sort((a, b) => a - b);
  let headerRow = -1;
  let anchors: { key: ColKey; box: Box }[] = [];
  for (const row of rows) {
    const lines = rowLines(lp, row);
    const joined = lines.map((l) => l.text).join(" ");
    // 見出し：品名 ＋ 数量 ＋ （金額・単価・単位のどれか）。または 品名 ＋ 単価 ＋ 金額
    const has = (k: ColKey) => HEADER[k].test(joined);
    if (!has("description")) continue;
    if (!((has("quantity") && (has("amount") || has("unit_price") || has("unit"))) || (has("unit_price") && has("amount")))) continue;
    const found: { key: ColKey; box: Box }[] = [];
    for (const key of Object.keys(HEADER) as ColKey[]) {
      for (const l of lines) {
        const m = HEADER[key].exec(l.text);
        if (!m) continue;
        // 「単価」の「価」を金額の見出しと取り違えない・「数量」の中の「数」を二重に数えない
        if (key === "amount" && /単価/.test(l.text) && !/金額/.test(l.text)) continue;
        const r = rangeSource(lp, l, m.index, m.index + m[0].length);
        if (r && !found.some((f) => Math.abs(f.box.x - r.box.x) < 0.005)) found.push({ key, box: r.box });
        break;
      }
    }
    if (found.length >= 3) {
      headerRow = row;
      anchors = found.sort((a, b) => a.box.x - b.box.x);
      break;
    }
  }
  if (headerRow < 0) return null;
  const headerLines = rowLines(lp, headerRow);
  const headerBottom = Math.max(...headerLines.map((l) => l.box.y + l.box.h));
  // 列の境目：となりの見出しの間
  const bounds = anchors.map((a, i) => {
    const left = i === 0 ? 0 : (anchors[i - 1].box.x + anchors[i - 1].box.w + a.box.x) / 2;
    const right = i === anchors.length - 1 ? 1 : (a.box.x + a.box.w + anchors[i + 1].box.x) / 2;
    return { key: a.key, left, right };
  });
  const usedLines = new Set(headerLines.map((l) => l.id));
  const fields: ExtractedField[] = [];
  const boxes: LineItemBox[] = [];
  let index = startIndex;
  let lastBottom = headerBottom;
  const rowHeights: number[] = [];
  type Pending = { cells: Map<ColKey, Cell>; box: Box };
  const items: Pending[] = [];

  for (const row of rows.filter((r) => r > headerRow)) {
    const lines = rowLines(lp, row);
    const top = Math.min(...lines.map((l) => l.box.y));
    const bottom = Math.max(...lines.map((l) => l.box.y + l.box.h));
    const h = bottom - top;
    const typical = rowHeights.length ? rowHeights.reduce((a, b) => a + b, 0) / rowHeights.length : h;
    if (top - lastBottom > Math.max(typical, h) * 4) break;
    const firstText = compactOf(lines[0]?.text ?? "");
    if (TABLE_END.test(firstText) || lines.some((l) => /^(小計|合計|以下余白)/.test(compactOf(l.text)))) break;
    const cells = new Map<ColKey, Cell>();
    for (const l of lines) {
      // 単語を中心の位置で列に振り分ける
      const wordIdx = [...new Set(l.charWord.filter((w) => w >= 0))];
      for (const wi of wordIdx) {
        const b = lp.page.words[wi].box;
        const cx = b.x + b.w / 2;
        const col = bounds.find((c) => cx >= c.left && cx < c.right) ?? bounds[bounds.length - 1];
        const cell = cells.get(col.key) ?? { words: [], text: "" };
        cell.words.push(wi);
        cell.text += lp.normWords[wi];
        cells.set(col.key, cell);
      }
      usedLines.add(l.id);
    }
    const rowBox = union(lines.map((l) => l.box)) as Box;
    const hasNumber = [...cells.entries()].some(([k, c]) => k !== "description" && /\d/.test(c.text));
    if (!hasNumber && items.length > 0 && cells.has("description") && top - lastBottom < h * 1.2) {
      // 品名の2行目（前の行の続き）
      const prev = items[items.length - 1];
      const d = prev.cells.get("description") ?? { words: [], text: "" };
      const add = cells.get("description") as Cell;
      prev.cells.set("description", { words: [...d.words, ...add.words], text: d.text + add.text });
      prev.box = union([prev.box, rowBox]) as Box;
    } else if (hasNumber || cells.has("description")) {
      items.push({ cells, box: rowBox });
    }
    rowHeights.push(h);
    lastBottom = bottom;
  }

  for (const item of items) {
    const line = index++;
    boxes.push({ index: line, page: lp.page.page, box: item.box });
    const get = (k: ColKey) => item.cells.get(k) ?? null;
    const push = (key: string, value: string | null, source: SourceRef | null, raw?: string) =>
      fields.push({ key, line, value, source: value === null ? null : source, raw: raw ?? null });

    const desc = get("description");
    let descText = desc?.text ?? "";
    let reduced = false;
    if (desc && /(※|軽)$|^(※|軽)/.test(descText)) reduced = true;
    if (desc) {
      const trimmed = descText.replace(/^(※|軽)\s?|\s?(※|軽)$/g, "");
      const start = descText.indexOf(trimmed);
      descText = trimmed;
      push("description", normalizeText(trimmed) || null, cellSource(lp, desc, start, start + trimmed.length));
    } else push("description", null, null);

    // 数量（「3台」のように単位が付いていれば分ける）
    const q = get("quantity");
    let unitFromQty: { text: string; source: SourceRef | null } | null = null;
    if (q) {
      const m = /^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)([^\d.,].*)?$/.exec(q.text);
      if (m) {
        const v = parseDecimalMilli(m[1]);
        push("quantity", v === null ? null : milliToString(v), cellSource(lp, q, 0, m[1].length));
        if (m[2]) unitFromQty = { text: m[2], source: cellSource(lp, q, m[1].length, q.text.length) };
      } else push("quantity", q.text || null, cellSource(lp, q), q.text);
    } else push("quantity", null, null);

    // 単位の列に、となりの単価がくっついて読まれたとき（「本2,800」）は分ける（単価の列が空のときだけ）
    const u = get("unit");
    let priceFromUnit: { text: string; source: SourceRef | null } | null = null;
    let unitText = u?.text ?? "";
    let unitSource = u ? cellSource(lp, u) : null;
    const UNIT_PRICE = /^([^\d\s.,]{1,3})(\d{1,3}(?:,\d{3})+|\d+)$/;
    if (u && !get("unit_price")) {
      const m = UNIT_PRICE.exec(u.text);
      if (m) {
        unitText = m[1];
        unitSource = cellSource(lp, u, 0, m[1].length);
        priceFromUnit = { text: m[2], source: cellSource(lp, u, m[1].length, u.text.length) };
      }
    } else if (!u && unitFromQty && q && !get("unit_price")) {
      // 数量の列に「4本2,800」（数量・単位・単価）が入ったとき
      const m = UNIT_PRICE.exec(unitFromQty.text);
      if (m) {
        const from = q.text.length - unitFromQty.text.length;
        unitFromQty = { text: m[1], source: cellSource(lp, q, from, from + m[1].length) };
        priceFromUnit = { text: m[2], source: cellSource(lp, q, from + m[1].length, q.text.length) };
      }
    }
    if (u && unitText) push("unit", unitText, unitSource);
    else if (unitFromQty) push("unit", unitFromQty.text, unitFromQty.source);
    else push("unit", null, null);

    for (const [key, col] of [["unit_price", "unit_price"], ["amount", "amount"]] as const) {
      const c = get(col);
      if (!c && key === "unit_price" && priceFromUnit) {
        const v = parseDecimalMilli(priceFromUnit.text);
        push(key, v === null ? null : milliToString(v), priceFromUnit.source);
        continue;
      }
      if (!c) {
        push(key, null, null);
        continue;
      }
      const v = key === "amount" ? parseYen(c.text) : parseDecimalMilli(c.text);
      if (v === null) push(key, c.text || null, cellSource(lp, c), c.text);
      else push(key, typeof v === "bigint" ? milliToString(v) : String(v), cellSource(lp, c));
    }

    const t = get("tax_rate");
    if (t) {
      const r = parseTaxRate(t.text);
      push("tax_rate", r ?? (t.text || null), cellSource(lp, t), t.text);
    } else if (reduced) {
      push("tax_rate", "8", desc ? cellSource(lp, desc) : null);
    } else push("tax_rate", null, null);
  }
  return { fields, boxes, usedLines, nextIndex: index };
}

/** 「10%対象 ¥7,300 消費税 ¥730」の「消費税」＝税率ごとの内訳（消費税の合計ではない） */
function isRateBreakdown(lp: LayoutPage, line: Line, labelStart: number): boolean {
  const before = [...rowLines(lp, line.row).filter((l) => l.box.x < line.box.x).map((l) => l.text), line.text.slice(0, labelStart)].join(" ");
  return /\d+\s?%\s?対象[^消税]*$/.test(compactOf(before));
}

// ---------------------------------------------------------------
// 本体
// ---------------------------------------------------------------
export function extractWithRules(pages: LayoutPage[], type: KnownType): { fields: ExtractedField[]; lineItems: LineItemBox[]; context: DocumentContext } {
  const fields: ExtractedField[] = [];
  const lineItems: LineItemBox[] = [];
  const excluded = new Set<string>();
  let nextIndex = 0;
  for (const lp of pages) {
    const t = parseTable(lp, nextIndex);
    if (!t) continue;
    fields.push(...t.fields);
    lineItems.push(...t.boxes);
    t.usedLines.forEach((id) => excluded.add(id));
    nextIndex = t.nextIndex;
  }

  const all: LRef[] = pages.flatMap((lp) => lp.lines.filter((l) => !excluded.has(l.id)).map((line) => ({ lp, line })));
  const fullText = pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n");
  const pick = (key: string, cands: Candidate[]): ExtractedField => {
    if (cands.length === 0) return { key, line: null, value: null, source: null };
    const sorted = [...cands].sort((a, b) => a.priority - b.priority || a.order - b.order);
    const best = sorted[0];
    const conflicts = sorted
      .filter((c) => c.strong && best.strong && c.value !== best.value)
      .filter((c, i, arr) => arr.findIndex((x) => x.value === c.value) === i)
      .map((c) => ({ value: c.value, source: c.source }));
    return { key, line: null, value: best.value, source: best.source, ...(conflicts.length ? { conflicts } : {}) };
  };

  // ラベルで探す項目
  for (const rule of RULES[type]) {
    const cands: Candidate[] = [];
    let order = 0;
    rule.labels.forEach((label, priority) => {
      for (const { lp, line } of all) {
        if (label.exclude && label.exclude.test(compactOf(line.text))) continue;
        const m = matchLabel(label.re, line.text);
        if (!m) continue;
        if (rule.key === "tax_amount" && isRateBreakdown(lp, line, m.index)) continue;
        let found = valueNear(lp, line, m.end, rule.kind, excluded);
        if (!found) continue;
        // 「消費税 10め ¥5,670」：ラベルのすぐ後の 10・8 は税率（「%」を読み違えたもの）。同じ段のその先に金額があればそちらを使う
        if (rule.key === "tax_amount" && (found.value === "10" || found.value === "8")) {
          const after = found.line.text.slice(found.end);
          const rateLike = (found.line === line && found.start - m.end <= 2) || /^[^\s\d円\-]/.test(after);
          const next = rateLike ? valueNear(lp, found.line, found.end, rule.kind, excluded, false) : null;
          if (next) found = next;
        }
        if (rule.kind === "text") {
          let v = found.line.text.slice(found.start, found.end).replace(/^[\s:：]+/, "").trim();
          if (rule.key === "purpose") v = v.replace(/^し\s?/, "");
          if (!v || v.length > 200) continue;
          cands.push({ value: v, raw: v, source: src(lp, found.line, found.start, found.end), priority, strong: false, order: order++ });
        } else {
          cands.push({ value: found.value, raw: found.line.text.slice(found.start, found.end), source: src(lp, found.line, found.start, found.end), priority, strong: !!label.strong, order: order++ });
        }
      }
    });
    fields.push(pick(rule.key, cands));
  }

  // 日付のラベルが無いとき：1ページ目の上の方にある日付
  const dateKey = type === "delivery_note" ? "delivery_date" : "issue_date";
  const dateField = fields.find((f) => f.key === dateKey && f.line === null);
  if (dateField && dateField.value === null) {
    for (const { lp, line } of all.filter((r) => r.lp === pages[0] && r.line.box.y < 0.3)) {
      // 支払期限などの日付（ラベルが同じ段の別の行にあるときも）は使わない
      if (rowLines(lp, line.row).some((l) => /(期限|期日|振込|支払|有効)/.test(compactOf(l.text)))) continue;
      const v = findValue("date", line.text);
      if (v) {
        dateField.value = v.value;
        dateField.source = src(lp, line, v.start, v.end);
        break;
      }
    }
  }

  // 税率ごとの内訳（10%対象 ¥100,000 消費税 ¥10,000）
  for (const rate of ["10", "8"] as const) {
    let base: ExtractedField = { key: `tax_${rate}_base`, line: null, value: null, source: null };
    let tax: ExtractedField = { key: `tax_${rate}`, line: null, value: null, source: null };
    for (const { lp, line } of all) {
      const m = new RegExp(`(?<!\\d)${rate}%\\s?対象`).exec(line.text);
      if (!m) continue;
      const seq: { line: Line; start: number; end: number; value: string }[] = [];
      const consider = [line, ...rowLines(lp, line.row).filter((l) => l.box.x > line.box.x)];
      consider.forEach((l, i) => {
        let offset = i === 0 ? m.index + m[0].length : 0;
        while (seq.length < 2) {
          const v = findValue("amount", l.text.slice(offset));
          if (!v) break;
          seq.push({ line: l, start: offset + v.start, end: offset + v.end, value: v.value });
          offset += v.end;
        }
      });
      if (seq[0]) base = { ...base, value: seq[0].value, source: src(lp, seq[0].line, seq[0].start, seq[0].end) };
      if (seq[1]) tax = { ...tax, value: seq[1].value, source: src(lp, seq[1].line, seq[1].start, seq[1].end) };
      break;
    }
    fields.push(base, tax);
  }

  // 会社名
  const firstPage = all.filter((r) => r.lp === pages[0]);
  let recipient: ExtractedField = { key: "recipient_name", line: null, value: null, source: null };
  for (const { lp, line } of firstPage) {
    const m = /^(?:(?:請求先|納品先|宛名|お客様名?)[\s:：]*)?(.+?)\s?(御\s?中|様|殿)/.exec(line.text);
    if (!m || m[1].length < 2) continue;
    const name = m[1].trim();
    const start = line.text.indexOf(name);
    recipient = { ...recipient, value: name, source: src(lp, line, start, start + name.length) };
    break;
  }
  let issuer: ExtractedField = { key: "issuer_name", line: null, value: null, source: null };
  const issuerLabel = all.find((r) => /^(発行元|発行者)[\s:：]*/.test(r.line.text));
  if (issuerLabel) {
    const m = /^(発行元|発行者)[\s:：]*/.exec(issuerLabel.line.text) as RegExpExecArray;
    const v = issuerLabel.line.text.slice(m[0].length).trim();
    if (v) issuer = { ...issuer, value: v, source: src(issuerLabel.lp, issuerLabel.line, m[0].length, issuerLabel.line.text.length) };
  }
  if (!issuer.value) {
    let best: { score: number; ref: LRef } | null = null;
    for (const ref of all) {
      const t = ref.line.text;
      if (!COMPANY_RE.test(compactOf(t)) || /(御\s?中|様|殿)/.test(t) || t.length > 40 || /[:：]/.test(t)) continue;
      if (recipient.value && t.includes(recipient.value)) continue;
      if (/(銀行|支店|口座|名義)/.test(t)) continue;
      let score = 1;
      if (ref.line.box.x > 0.45) score += 2;
      const near = all.some((o) => o.lp === ref.lp && o.line.id !== ref.line.id && /(〒|TEL|電話|登録番号|住所|FAX|\d{2,4}-\d{2,4}-\d{3,4})/i.test(o.line.text)
        && o.line.box.y > ref.line.box.y && o.line.box.y - ref.line.box.y < 0.12 && Math.abs(o.line.box.x - ref.line.box.x) < 0.2);
      if (near) score += 3;
      if (ref.lp === pages[0]) score += 1;
      if (!best || score > best.score) best = { score, ref };
    }
    if (best && best.score >= 3) {
      const t = best.ref.line.text;
      issuer = { ...issuer, value: t.trim(), source: src(best.ref.lp, best.ref.line, 0, t.length) };
    }
  }
  fields.push(issuer, recipient);

  // 支払方法（ラベルが無いとき、レシートの定型の語）
  if (type === "receipt") {
    const pm = fields.find((f) => f.key === "payment_method");
    if (pm && pm.value) {
      const m = PAYMENT_RE.exec(pm.value);
      if (!m) pm.value = pm.value.slice(0, 30);
    } else if (pm) {
      for (const { lp, line } of all) {
        const m = PAYMENT_RE.exec(line.text);
        if (m && line.text.length < 20) {
          pm.value = m[0];
          pm.source = src(lp, line, m.index, m.index + m[0].length);
          break;
        }
      }
    }
  }

  // 帳票の書き方の手がかり
  const statedRates = new Set<"10" | "8">();
  for (const { line } of all) {
    if (!/消費税|税額/.test(line.text) || /対象/.test(line.text)) continue;
    const m = /(10|8)\s?%/.exec(line.text);
    if (m) statedRates.add(m[1] as "10" | "8");
  }
  const included = /(内税|内消費税|税込(価格|金額|合計)?|\(税込\))/.test(fullText);
  const excludedTax = /(外税|税抜|税別|\(税別\))/.test(fullText);
  const rounding = /端数[^\n]{0,6}(切り?捨|切捨)/.test(fullText) ? "floor" : /端数[^\n]{0,6}切り?上/.test(fullText) ? "ceil" : /端数[^\n]{0,6}四捨五入/.test(fullText) ? "round" : null;
  const context: DocumentContext = {
    textFound: fullText.replace(/\s/g, "").length >= 10,
    taxIncluded: included && !excludedTax ? true : excludedTax && !included ? false : null,
    rounding,
    statedRates: [...statedRates],
    hasReducedMarker: /(軽減税率|※印?は軽減|(?<!\d)8%)/.test(fullText) || fields.some((f) => f.key === "tax_rate" && f.value === "8"),
  };

  // 文字の項目：OCR が日本語の文字の間に入れた空白を除く（値の位置はそのまま）
  for (const f of fields) {
    if (f.value !== null && TEXT_KEYS.has(f.key)) f.value = tidySpaces(f.value);
  }
  return { fields: fields.filter((f, i, arr) => arr.findIndex((x) => x.key === f.key && x.line === f.line) === i), lineItems, context };
}
