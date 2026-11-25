/**
 * 金額の照合。帳票の書き方（税抜・税込・複数税率・端数処理）の違いを考え、
 *   一致（match）／不一致（mismatch）／検証不能（unverifiable）を区別する。
 * 計算方式が特定できないときは不一致と断定せず「検証不能」にする（画面では要確認）。
 * 金額は円の整数、数量・単価は 1/1000 単位の BigInt。浮動小数点は使わない。
 */
import { formatYen } from "./values";

export type Rounding = "floor" | "round" | "ceil";
export const ROUNDINGS: Rounding[] = ["floor", "round", "ceil"];

export type ReconcileLine = {
  index: number;
  quantityMilli: bigint | null;
  unitPriceMilli: bigint | null;
  amount: number | null;
  taxRate: "10" | "8" | "0" | null;
};

export type ReconcileInput = {
  subtotal: number | null;
  taxAmount: number | null;
  total: number | null;
  discount: number | null;
  shipping: number | null;
  tax10Base: number | null;
  tax10: number | null;
  tax8Base: number | null;
  tax8: number | null;
  lines: ReconcileLine[];
  /** 税込（内税）の帳票か。分からなければ null */
  taxIncluded: boolean | null;
  /** 帳票に書かれた端数処理（分からなければ null＝3通りのどれかに合えば一致） */
  rounding: Rounding | null;
  /** 帳票に書かれた税率（「消費税(10%)」などから） */
  statedRates: ("10" | "8")[];
  /** 帳票に軽減税率の印（※・軽減・8%）があるか */
  hasReducedMarker: boolean;
};

export type FieldRef = { key: string; line: number | null };

export type CheckStatus = "match" | "mismatch" | "unverifiable";

export type AmountCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  /** 照合の対象（不一致のとき赤で示す項目。先頭が代表） */
  fields: FieldRef[];
  expected: number | null;
  actual: number | null;
  reason: string;
  /** 関係する値（承認したあとに値が変わったら、もう一度確認が要る） */
  sig: string;
};

/** 割り算の端数処理（分子・分母とも BigInt、分母は正） */
export function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const negative = n < 0n;
  if (mode === "floor") return negative ? q - 1n : q;
  if (mode === "ceil") return negative ? q : q + 1n;
  // 四捨五入（0 から遠い方へ）
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= d) return negative ? q - 1n : q + 1n;
  return q;
}

/** 税額の候補（端数処理ごと）。exclusive：税抜の金額から、inclusive：税込の金額から */
export function taxCandidates(base: number, rate: number, inclusive: boolean, rounding: Rounding | null): number[] {
  const modes = rounding ? [rounding] : ROUNDINGS;
  const b = BigInt(base);
  const r = BigInt(rate);
  const values = modes.map((m) => Number(inclusive ? divRound(b * r, 100n + r, m) : divRound(b * r, 100n, m)));
  return [...new Set(values)];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const sigOf = (...xs: (number | bigint | string | null)[]) => xs.map((x) => (x === null ? "_" : String(x))).join("|");

export function reconcile(input: ReconcileInput): AmountCheck[] {
  const checks: AmountCheck[] = [];
  const included = input.taxIncluded === true;

  // 1. 明細：数量 × 単価 ＝ 金額
  for (const line of input.lines) {
    if (line.quantityMilli === null || line.unitPriceMilli === null || line.amount === null) continue;
    const product = line.quantityMilli * line.unitPriceMilli; // 1/1,000,000 円
    const modes = input.rounding ? [input.rounding] : ROUNDINGS;
    const candidates = [...new Set(modes.map((m) => Number(divRound(product, 1_000_000n, m))))];
    const ok = candidates.includes(line.amount);
    checks.push({
      id: `line.${line.index}`,
      label: `明細${line.index + 1} 数量×単価`,
      status: ok ? "match" : "mismatch",
      fields: [{ key: "amount", line: line.index }, { key: "quantity", line: line.index }, { key: "unit_price", line: line.index }],
      expected: candidates[0],
      actual: line.amount,
      reason: ok ? "一致" : `数量×単価＝${formatYen(candidates[0])}（記載 ${formatYen(line.amount)}）`,
      sig: sigOf(line.quantityMilli, line.unitPriceMilli, line.amount),
    });
  }

  const lineAmounts = input.lines.map((l) => l.amount);
  const allLineAmounts = input.lines.length > 0 && lineAmounts.every((a) => a !== null);
  const lineSum = allLineAmounts ? sum(lineAmounts as number[]) : null;

  // 2. 明細の合計 ＝ 小計（値引きを小計の前に引く書き方・後に引く書き方のどちらも認める）
  if (lineSum !== null && input.subtotal !== null) {
    const options = [lineSum];
    if (input.discount) options.push(lineSum - Math.abs(input.discount));
    if (input.shipping) options.push(lineSum + input.shipping, lineSum + input.shipping - Math.abs(input.discount ?? 0));
    const ok = options.includes(input.subtotal);
    checks.push({
      id: "subtotal",
      label: "明細の合計と小計",
      status: ok ? "match" : "mismatch",
      fields: [{ key: "subtotal", line: null }],
      expected: lineSum,
      actual: input.subtotal,
      reason: ok ? "一致" : `明細の合計＝${formatYen(lineSum)}（小計 ${formatYen(input.subtotal)}）`,
      sig: sigOf(lineSum, input.subtotal, input.discount, input.shipping),
    });
  }

  // 3. 消費税
  const base = input.subtotal ?? lineSum;
  const breakdown: { rate: 10 | 8; base: number | null; tax: number | null; keyBase: string; keyTax: string }[] = [
    { rate: 10, base: input.tax10Base, tax: input.tax10, keyBase: "tax_10_base", keyTax: "tax_10" },
    { rate: 8, base: input.tax8Base, tax: input.tax8, keyBase: "tax_8_base", keyTax: "tax_8" },
  ];
  const hasBreakdown = breakdown.some((b) => b.base !== null && b.tax !== null);
  if (hasBreakdown) {
    for (const b of breakdown) {
      if (b.base === null || b.tax === null) continue;
      // 「N%対象」の金額は税抜・税込のどちらの書き方もある。税抜と分かっている帳票以外は両方を認める
      const cands = input.taxIncluded === false
        ? taxCandidates(b.base, b.rate, false, input.rounding)
        : [...new Set([...taxCandidates(b.base, b.rate, included, input.rounding), ...taxCandidates(b.base, b.rate, !included, input.rounding)])];
      const ok = cands.includes(b.tax);
      checks.push({
        id: `tax.${b.rate}`,
        label: `消費税${b.rate}%`,
        status: ok ? "match" : "mismatch",
        fields: [{ key: b.keyTax, line: null }, { key: b.keyBase, line: null }],
        expected: cands[0],
        actual: b.tax,
        reason: ok ? "一致" : `${formatYen(b.base)}の${b.rate}%＝${formatYen(cands[0])}（記載 ${formatYen(b.tax)}）`,
        sig: sigOf(b.base, b.tax, input.rounding),
      });
    }
    const taxes = breakdown.filter((b) => b.tax !== null).map((b) => b.tax as number);
    if (input.taxAmount !== null && taxes.length > 0 && sum(taxes) !== input.taxAmount) {
      checks.push({
        id: "tax.sum",
        label: "税率ごとの消費税の合計",
        status: "mismatch",
        fields: [{ key: "tax_amount", line: null }],
        expected: sum(taxes),
        actual: input.taxAmount,
        reason: `税率ごとの合計＝${formatYen(sum(taxes))}（消費税 ${formatYen(input.taxAmount)}）`,
        sig: sigOf(...taxes, input.taxAmount),
      });
    }
  } else if (input.taxAmount !== null && base !== null) {
    const lineRates = input.lines.map((l) => l.taxRate);
    const allRatesKnown = input.lines.length > 0 && lineRates.every((r) => r !== null) && allLineAmounts;
    let cands: number[] | null = null;
    let basis = "";
    if (allRatesKnown) {
      // 税率ごとに合計してから1回だけ端数処理（インボイス制度の計算）
      const byRate = new Map<string, number>();
      input.lines.forEach((l) => byRate.set(l.taxRate as string, (byRate.get(l.taxRate as string) ?? 0) + (l.amount as number)));
      const modes = input.rounding ? [input.rounding] : ROUNDINGS;
      cands = [...new Set(modes.map((m) => {
        let t = 0;
        for (const [rate, amt] of byRate) if (rate !== "0") t += taxCandidates(amt, Number(rate), included, m)[0];
        return t;
      }))];
      basis = "明細の税率";
      // 値引きがあると税率ごとの按分が分からない
      if (input.discount) cands = null;
    } else {
      const rates = new Set(input.statedRates);
      if (rates.size === 1 && !(rates.has("10") && input.hasReducedMarker)) {
        cands = taxCandidates(base, Number([...rates][0]), included, input.rounding);
        basis = `${[...rates][0]}%`;
      } else if (rates.size === 0 && !input.hasReducedMarker) {
        const c10 = taxCandidates(base, 10, included, input.rounding);
        if (c10.includes(input.taxAmount)) {
          cands = c10;
          basis = "10%";
        }
      }
    }
    if (cands) {
      const ok = cands.includes(input.taxAmount);
      checks.push({
        id: "tax",
        label: "消費税",
        status: ok ? "match" : "mismatch",
        fields: [{ key: "tax_amount", line: null }, { key: "subtotal", line: null }],
        expected: cands[0],
        actual: input.taxAmount,
        reason: ok ? "一致" : `${basis}で計算すると${formatYen(cands[0])}（記載 ${formatYen(input.taxAmount)}）`,
        sig: sigOf(base, input.taxAmount, basis),
      });
    } else {
      checks.push({
        id: "tax",
        label: "消費税",
        status: "unverifiable",
        fields: [{ key: "tax_amount", line: null }],
        expected: null,
        actual: input.taxAmount,
        reason: "税率の内訳が分からないため検証できません",
        sig: sigOf(base, input.taxAmount),
      });
    }
  }

  // 4. 合計
  if (input.total !== null && base !== null) {
    const discount = Math.abs(input.discount ?? 0);
    const shipping = input.shipping ?? 0;
    const tax = included ? 0 : input.taxAmount;
    if (tax === null && input.taxIncluded === null) {
      // 消費税が読めていない（税込かどうかも不明）：小計＝合計なら税込の書き方として一致、そうでなければ検証不能
      const ok = [base, base - discount, base + shipping, base + shipping - discount].includes(input.total);
      checks.push({
        id: "total",
        label: "合計",
        status: ok ? "match" : "unverifiable",
        fields: [{ key: "total_amount", line: null }],
        expected: null,
        actual: input.total,
        reason: ok ? "一致" : "消費税が分からないため検証できません",
        sig: sigOf(base, input.total, input.discount, input.shipping),
      });
    } else {
      const t = tax ?? 0;
      const options = [base + t, base + t - discount, base + t + shipping, base + t + shipping - discount];
      // 小計が値引き・送料を含んでいる書き方
      const ok = options.includes(input.total);
      const expected = base + t + shipping - discount;
      checks.push({
        id: "total",
        label: "合計",
        status: ok ? "match" : "mismatch",
        fields: [{ key: "total_amount", line: null }, { key: "subtotal", line: null }, { key: "tax_amount", line: null }],
        expected,
        actual: input.total,
        reason: ok
          ? "一致"
          : included
            ? `明細・小計の合計＝${formatYen(expected)}（合計 ${formatYen(input.total)}）`
            : `小計＋消費税＝${formatYen(expected)}（合計 ${formatYen(input.total)}）`,
        sig: sigOf(base, input.taxAmount, input.total, input.discount, input.shipping),
      });
    }
  } else if (input.total !== null && lineSum === null && input.subtotal === null && hasBreakdown) {
    const bases = breakdown.filter((b) => b.base !== null);
    const taxes = breakdown.filter((b) => b.tax !== null);
    const baseSum = sum(bases.map((b) => b.base as number));
    const taxSum = sum(taxes.map((b) => b.tax as number));
    // 税抜の内訳（対象額＋税＝合計）と税込の内訳（対象額＝合計）のどちらか
    const expected = included ? baseSum : baseSum + taxSum;
    const ok = input.total === baseSum + taxSum || (input.taxIncluded !== false && input.total === baseSum);
    checks.push({
      id: "total",
      label: "合計",
      status: ok ? "match" : "mismatch",
      fields: [{ key: "total_amount", line: null }],
      expected,
      actual: input.total,
      reason: ok ? "一致" : `税率ごとの合計＝${formatYen(expected)}（合計 ${formatYen(input.total)}）`,
      sig: sigOf(expected, input.total),
    });
  }
  return checks;
}
