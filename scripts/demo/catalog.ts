/**
 * デモ書類の一覧（すべて架空。会社名・住所・電話・登録番号・口座は実在しない形にしている）。
 *   住所は「架空町」、電話は 0000 を含む番号、登録番号は T000000000xxxx（実在の法人番号は先頭が 1〜9）。
 * truth は書類に印字した値（読取の正解）。精度の測定（scripts/demo/evaluate.ts）に使う。
 */
export type Line = { description: string; quantity: string; unit: string; unitPrice: number | null; amount: number | null; taxRate?: "10" | "8" };

export type Party = { name: string; postal: string; address: string; tel: string; reg?: string };

export type Render = "pdf" | "scan_pdf" | "png_scan" | "jpeg_scan" | "jpeg_low" | "webp_photo" | "png_blur_number" | "jpeg_unreadable" | "png_clean";

export type DemoDoc = {
  id: string;
  filename: string;
  kind: "invoice" | "receipt" | "delivery_note" | "quote";
  style?: "formal" | "shop";
  render: Render;
  /** 同じファイル（バイト列）を別名で作る：重複のデモ */
  copyOf?: string;
  pattern: string;
  issuer: Party | null;
  recipient: string;
  number: string | null;
  issueDate: string | null; // YYYY-MM-DD（印字しない場合は null）
  dueDate?: string | null;
  lines: Line[];
  /** 印字する金額（不一致のデモは計算と違う値を印字する） */
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  discount?: number;
  shipping?: number;
  breakdown?: { rate: "10" | "8"; base: number; tax: number }[];
  taxIncluded?: boolean;
  taxLabelRate?: "10" | "8" | null;
  purpose?: string;
  paymentMethod?: string;
  notes?: string;
  /** 1ページに入れる明細の行数（複数ページのデモ） */
  linesPerPage?: number;
  /** 3ページ目に振込先・備考を分けて載せる */
  extraPage?: boolean;
  /** デモの初期状態：確定済みにする（過去の処理の履歴） */
  confirmDaysAgo?: number;
};

const party = (name: string, n: number, city: string, reg = true): Party => ({
  name,
  postal: `〒100-00${String(n).padStart(2, "0")}`,
  address: `${city}架空町${n}-${n + 2}-${n + 5}`,
  tel: `TEL 03-0000-${String(1000 + n * 37).slice(0, 4)}`,
  reg: reg ? `T00000000000${String(n).padStart(2, "0")}` : undefined,
});

export const RECIPIENT = "株式会社山田商事";

const P = {
  towa: party("東和電材株式会社", 11, "東京都千代田区"),
  sunrise: party("株式会社サンライズ印刷", 12, "東京都台東区"),
  hokuto: party("株式会社北斗オフィスサプライ", 13, "埼玉県さいたま市"),
  maruei: party("丸栄食品株式会社", 14, "千葉県船橋市"),
  greentech: party("株式会社グリーンテック設備", 15, "神奈川県横浜市"),
  nextweb: party("合同会社ネクストウェブ", 16, "東京都渋谷区"),
  daiwa: party("株式会社大和梱包資材", 17, "埼玉県川口市"),
  aoba: party("株式会社あおば清掃サービス", 18, "東京都品川区"),
  sanwa: party("株式会社三和工具", 19, "東京都大田区"),
  midori: party("有限会社みどり運送", 20, "千葉県市川市"),
  komorebi: party("喫茶こもれび", 21, "東京都中央区"),
  smile: party("株式会社スマイル文具", 22, "東京都中央区"),
  hayate: party("はやて交通株式会社", 23, "東京都江東区"),
  maruya: party("お弁当のまるや", 24, "東京都中央区"),
  chie: party("株式会社知恵の森書店", 25, "東京都千代田区"),
  park: party("株式会社パークサポート", 26, "東京都中央区"),
  hotel: party("ホテル架空ステイ株式会社", 27, "大阪府大阪市北区"),
};

const L = (description: string, quantity: string, unit: string, unitPrice: number | null, taxRate?: "10" | "8"): Line => ({
  description, quantity, unit, unitPrice,
  amount: unitPrice === null ? null : Math.floor(Number(quantity) * unitPrice),
  taxRate,
});

const sum = (lines: Line[]) => lines.reduce((a, l) => a + (l.amount ?? 0), 0);
const tax10 = (n: number) => Math.floor(n * 0.1);

function invoice(base: Omit<DemoDoc, "subtotal" | "tax" | "total" | "kind"> & Partial<Pick<DemoDoc, "subtotal" | "tax" | "total">>): DemoDoc {
  const subtotal = base.subtotal ?? sum(base.lines) - (base.discount ?? 0) + (base.shipping ?? 0);
  const tax = base.tax ?? tax10(subtotal);
  return { kind: "invoice", taxLabelRate: "10", ...base, subtotal, tax, total: base.total ?? subtotal + tax };
}

const towaLines = [L("VVFケーブル 2.0mm×3C 100m", "4", "巻", 12800), L("スイッチボックス 1個用", "50", "個", 180), L("LED照明器具 40W形", "12", "台", 5400), L("配線工事用ステップル", "10", "箱", 650)];
const sunriseLines = [L("会社案内パンフレット A4 8P", "1000", "部", 68), L("名刺印刷 100枚", "12", "箱", 1500), L("封筒 長3 社名入り", "2000", "枚", 9)];
const hokutoLines = [
  "コピー用紙 A4 500枚", "コピー用紙 A3 500枚", "ボールペン 黒 10本", "ボールペン 赤 10本", "蛍光ペン 5色セット", "クリアファイル A4 10枚", "フラットファイル A4", "ホチキス針 No.10",
  "付箋 75×75mm", "ガムテープ 50mm", "電池 単3 20本", "ゴミ袋 45L 50枚", "トイレットペーパー 12ロール", "ハンドソープ 詰替", "ティッシュ 5箱", "紙コップ 100個",
  "インクカートリッジ 黒", "インクカートリッジ カラー", "ラベルシール A4", "OAタップ 6口", "LANケーブル 5m", "USBメモリ 32GB", "マウス 無線", "キーボード",
  "デスクマット", "モニターアーム", "ホワイトボードマーカー", "印鑑マット",
].map((d, i) => L(d, String((i % 5) + 1), ["箱", "個", "本", "冊", "式"][i % 5], [2980, 3480, 980, 980, 650, 420, 120, 220, 380, 450, 1280, 690, 1980, 540, 1100, 380, 3200, 4100, 1500, 2480, 780, 1280, 1980, 2980, 1580, 6980, 640, 880][i]));
const daiwaLines = [L("段ボール箱 60サイズ", "300", "枚", 85), L("緩衝材 エアーキャップ", "10", "巻", 2400), L("OPPテープ 48mm", "60", "巻", 120)];
const sanwaLines = [L("インパクトドライバー", "2", "台", 24800), L("ドリルビットセット", "3", "セット", 3600), L("作業用手袋", "20", "双", 280)];
const greenLines = [L("エアコンフィルター交換", "6", "台", 4500), L("ドレン配管清掃", "6", "台", 3000), L("出張費", "1", "式", 5000)];

export const CATALOG: DemoDoc[] = [
  // ---------------- 請求書 ----------------
  invoice({ id: "I01", filename: "請求書_東和電材_INV-2026-0085.pdf", render: "pdf", pattern: "正常な請求書", issuer: P.towa, recipient: RECIPIENT, number: "INV-2026-0085", issueDate: "2026-11-20", dueDate: "2026-12-31", lines: towaLines, notes: "いつもお引き立ていただきありがとうございます。", confirmDaysAgo: 0 }),
  invoice({
    id: "I02", filename: "請求書_丸栄食品_MF-24117.pdf", render: "pdf", pattern: "8%・10% 混在", issuer: P.maruei, recipient: RECIPIENT, number: "MF-24117", issueDate: "2026-11-15", dueDate: "2026-12-15",
    lines: [L("※ 業務用コーヒー豆 1kg", "6", "袋", 2400, "8"), L("※ 緑茶ティーバッグ 100P", "10", "箱", 980, "8"), L("紙コップ 205ml 1000個", "2", "箱", 3200, "10"), L("マドラー 1000本", "1", "箱", 900, "10")],
    subtotal: 31500, tax: 2666, total: 34166, taxLabelRate: null,
    breakdown: [{ rate: "8", base: 24200, tax: 1936 }, { rate: "10", base: 7300, tax: 730 }],
  }),
  invoice({ id: "I03", filename: "請求書_サンライズ印刷_スキャン.png", render: "png_blur_number", pattern: "読みにくい請求番号", issuer: P.sunrise, recipient: RECIPIENT, number: "SR-2026-0347", issueDate: "2026-11-10", dueDate: "2026-11-30", lines: sunriseLines }),
  invoice({ id: "I04", filename: "請求書_三和工具_0912.pdf", render: "pdf", pattern: "金額不一致", issuer: P.sanwa, recipient: RECIPIENT, number: "SW-0912", issueDate: "2026-11-18", dueDate: "2026-12-20", lines: [L("インパクトドライバー", "2", "台", 24800), L("ドリルビットセット", "3", "セット", 3600), L("作業台 折りたたみ", "1", "台", 39600)], subtotal: 100000, tax: 10000, total: 110800 }),
  invoice({ id: "I05", filename: "請求書_グリーンテック設備_GT-1188.pdf", render: "pdf", pattern: "消費税の不整合", issuer: P.greentech, recipient: RECIPIENT, number: "GT-1188", issueDate: "2026-11-12", dueDate: "2026-12-10", lines: [L("空調設備点検", "1", "式", 60000), L("フィルター交換", "8", "台", 5000)], tax: 9000, total: 109000 }),
  { ...invoice({ id: "I06", filename: "請求書_東和電材_INV-2026-0085(再送).pdf", render: "pdf", pattern: "重複書類（同じファイル）", issuer: P.towa, recipient: RECIPIENT, number: "INV-2026-0085", issueDate: "2026-11-20", dueDate: "2026-12-31", lines: towaLines, notes: "いつもお引き立ていただきありがとうございます。" }), copyOf: "I01" },
  invoice({ id: "I07", filename: "請求書_ネクストウェブ_NW-2026-031.pdf", render: "pdf", pattern: "正常な請求書", issuer: P.nextweb, recipient: RECIPIENT, number: "NW-2026-031", issueDate: "2026-10-31", dueDate: "2026-11-30", lines: [L("コーポレートサイト保守 10月分", "1", "式", 55000), L("採用ページ更新", "1", "式", 38000)], confirmDaysAgo: 18 }),
  invoice({ id: "I08", filename: "請求書_ネクストウェブ_再送スキャン.jpg", render: "jpeg_scan", pattern: "重複書類（同じ請求番号）", issuer: P.nextweb, recipient: RECIPIENT, number: "NW-2026-031", issueDate: "2026-10-31", dueDate: "2026-11-30", lines: [L("コーポレートサイト保守 10月分", "1", "式", 55000), L("採用ページ更新", "1", "式", 38000)] }),
  invoice({ id: "I09", filename: "請求書_北斗オフィスサプライ_明細28行.pdf", render: "pdf", pattern: "明細が多い（2ページ）", issuer: P.hokuto, recipient: RECIPIENT, number: "HK-26-1102", issueDate: "2026-11-05", dueDate: "2026-11-30", lines: hokutoLines, linesPerPage: 18, confirmDaysAgo: 10 }),
  invoice({ id: "I10", filename: "請求書_みどり運送_3ページ.pdf", render: "pdf", pattern: "複数ページ（3ページ）", issuer: P.midori, recipient: RECIPIENT, number: "MD-2026-1101", issueDate: "2026-11-01", dueDate: "2026-11-30", lines: [L("チャーター便 東京→横浜", "4", "便", 18000), L("チャーター便 東京→千葉", "6", "便", 15000), L("待機料", "3", "時間", 3000), L("高速道路代（実費）", "1", "式", 12400)], linesPerPage: 4, extraPage: true, notes: "高速道路代は実費精算です。", confirmDaysAgo: 15 }),
  invoice({ id: "I11", filename: "請求書_大和梱包資材_スキャン.pdf", render: "scan_pdf", pattern: "スキャン形式の PDF", issuer: P.daiwa, recipient: RECIPIENT, number: "DW-58821", issueDate: "2026-11-08", dueDate: "2026-12-08", lines: daiwaLines }),
  invoice({ id: "I12", filename: "請求書_あおば清掃_低解像度.jpg", render: "jpeg_low", pattern: "低解像度の画像", issuer: P.aoba, recipient: RECIPIENT, number: "AB-1120", issueDate: "2026-11-20", dueDate: "2026-12-25", lines: [L("定期清掃 11月分", "1", "式", 48000), L("ワックス掛け", "120", "㎡", 150)] }),
  invoice({ id: "I13", filename: "請求書_東和電材_日付なし.pdf", render: "pdf", pattern: "必須項目欠落（発行日なし）", issuer: P.towa, recipient: RECIPIENT, number: "INV-2026-0091", issueDate: null, dueDate: "2026-12-31", lines: [L("分電盤 主幹50A", "2", "台", 32000), L("ブレーカー 20A", "10", "個", 1450)] }),
  invoice({ id: "I14", filename: "請求書_北斗オフィスサプライ_値引き送料.pdf", render: "pdf", pattern: "値引き・送料", issuer: P.hokuto, recipient: RECIPIENT, number: "HK-26-1115", issueDate: "2026-11-15", dueDate: "2026-12-15", lines: [L("オフィスチェア", "4", "脚", 18800), L("デスク 120cm", "2", "台", 32000)], discount: 5000, shipping: 3000, confirmDaysAgo: 3 }),
  {
    ...invoice({ id: "I15", filename: "請求書_サンライズ印刷_税込.pdf", render: "pdf", pattern: "税込（内税）の請求書", issuer: P.sunrise, recipient: RECIPIENT, number: "SR-2026-0322", issueDate: "2026-10-25", dueDate: "2026-11-25", lines: [L("ポスター印刷 B2（税込）", "50", "枚", 660), L("パネル加工（税込）", "5", "枚", 3300)] }),
    subtotal: 49500, tax: 4500, total: 49500, taxIncluded: true, taxLabelRate: "10", confirmDaysAgo: 20,
  },
  invoice({ id: "I16", filename: "請求書_ネクストウェブ_写真.webp", render: "webp_photo", pattern: "画像（WebP）", issuer: P.nextweb, recipient: RECIPIENT, number: "NW-2026-034", issueDate: "2026-11-19", dueDate: "2026-12-19", lines: [L("LP制作", "1", "式", 120000), L("画像素材購入", "3", "点", 4000)] }),

  // ---------------- 領収書 ----------------
  { id: "R01", filename: "領収書_喫茶こもれび.pdf", kind: "receipt", style: "formal", render: "pdf", pattern: "正常な領収書", issuer: P.komorebi, recipient: RECIPIENT, number: "0472", issueDate: "2026-11-19", lines: [], subtotal: null, tax: null, total: 3300, breakdown: [{ rate: "10", base: 3000, tax: 300 }], taxIncluded: true, purpose: "会議用飲食代として", paymentMethod: "現金", confirmDaysAgo: 1 },
  { id: "R02", filename: "領収書_スマイル文具.pdf", kind: "receipt", style: "formal", render: "pdf", pattern: "但し書きあり", issuer: P.smile, recipient: RECIPIENT, number: "SM-8812", issueDate: "2026-11-14", lines: [], subtotal: null, tax: null, total: 8250, breakdown: [{ rate: "10", base: 7500, tax: 750 }], taxIncluded: true, purpose: "文具代として", paymentMethod: "現金", confirmDaysAgo: 6 },
  { id: "R03", filename: "領収書_はやて交通_タクシー.png", kind: "receipt", style: "formal", render: "png_scan", pattern: "画像（スキャン）", issuer: P.hayate, recipient: RECIPIENT, number: "T-55120", issueDate: "2026-11-17", lines: [], subtotal: null, tax: null, total: 4620, breakdown: [{ rate: "10", base: 4200, tax: 420 }], taxIncluded: true, purpose: "乗車料金として", paymentMethod: "クレジットカード" },
  {
    id: "R04", filename: "レシート_お弁当のまるや.pdf", kind: "receipt", style: "shop", render: "pdf", pattern: "8%・10% 混在のレシート", issuer: P.maruya, recipient: "", number: "000318", issueDate: "2026-11-18",
    lines: [L("※ 幕の内弁当", "5", "個", 864, "8"), L("※ 緑茶 500ml", "5", "本", 162, "8"), L("割り箸セット", "1", "袋", 330, "10")],
    subtotal: 5460, tax: 410, total: 5460, breakdown: [{ rate: "8", base: 5130, tax: 380 }, { rate: "10", base: 330, tax: 30 }], taxIncluded: true, paymentMethod: "現金", confirmDaysAgo: 2,
  },
  { id: "R05", filename: "領収書_知恵の森書店_低解像度.jpg", kind: "receipt", style: "formal", render: "jpeg_low", pattern: "低解像度の画像", issuer: P.chie, recipient: RECIPIENT, number: "CM-3391", issueDate: "2026-11-11", lines: [], subtotal: null, tax: null, total: 6380, breakdown: [{ rate: "10", base: 5800, tax: 580 }], taxIncluded: true, purpose: "書籍代として", paymentMethod: "現金" },
  { id: "R06", filename: "領収書_パークサポート_駐車場.png", kind: "receipt", style: "formal", render: "png_clean", pattern: "画像（PNG）", issuer: P.park, recipient: RECIPIENT, number: "P-20261116", issueDate: "2026-11-16", lines: [], subtotal: null, tax: null, total: 1800, breakdown: [{ rate: "10", base: 1637, tax: 163 }], taxIncluded: true, purpose: "駐車料金として", paymentMethod: "現金", confirmDaysAgo: 4 },
  { id: "R07", filename: "領収書_発行元なし.pdf", kind: "receipt", style: "formal", render: "pdf", pattern: "必須項目欠落（発行元なし）", issuer: null, recipient: RECIPIENT, number: "1203", issueDate: "2026-11-13", lines: [], subtotal: null, tax: null, total: 2200, breakdown: [{ rate: "10", base: 2000, tax: 200 }], taxIncluded: true, purpose: "お品代として", paymentMethod: "現金" },
  { id: "R08", filename: "領収書_ホテル架空ステイ.pdf", kind: "receipt", style: "formal", render: "pdf", pattern: "支払方法（カード）", issuer: P.hotel, recipient: RECIPIENT, number: "HS-77120", issueDate: "2026-11-07", lines: [], subtotal: null, tax: null, total: 15400, breakdown: [{ rate: "10", base: 14000, tax: 1400 }], taxIncluded: true, purpose: "宿泊代として", paymentMethod: "クレジットカード", confirmDaysAgo: 12 },
  { id: "R09", filename: "領収書_読取不可.jpg", kind: "receipt", style: "formal", render: "jpeg_unreadable", pattern: "読取失敗（ピンぼけ）", issuer: P.smile, recipient: RECIPIENT, number: "SM-8840", issueDate: "2026-11-20", lines: [], subtotal: null, tax: null, total: 1650, breakdown: [{ rate: "10", base: 1500, tax: 150 }], taxIncluded: true, purpose: "文具代として", paymentMethod: "現金" },
  { id: "R10", filename: "領収書_あおば清掃.pdf", kind: "receipt", style: "formal", render: "pdf", pattern: "正常な領収書", issuer: P.aoba, recipient: RECIPIENT, number: "AB-R-0915", issueDate: "2026-11-20", lines: [], subtotal: null, tax: null, total: 22000, breakdown: [{ rate: "10", base: 20000, tax: 2000 }], taxIncluded: true, purpose: "エアコン清掃代として", paymentMethod: "銀行振込" },

  // ---------------- 納品書 ----------------
  { id: "D01", filename: "納品書_東和電材_DN-5521.pdf", kind: "delivery_note", render: "pdf", pattern: "正常な納品書", issuer: P.towa, recipient: RECIPIENT, number: "DN-5521", issueDate: "2026-11-18", lines: towaLines.slice(0, 3), subtotal: sum(towaLines.slice(0, 3)), tax: tax10(sum(towaLines.slice(0, 3))), total: sum(towaLines.slice(0, 3)) + tax10(sum(towaLines.slice(0, 3))), taxLabelRate: "10", confirmDaysAgo: 2 },
  { id: "D02", filename: "納品書_大和梱包資材_N-30418.pdf", kind: "delivery_note", render: "pdf", pattern: "正常な納品書", issuer: P.daiwa, recipient: RECIPIENT, number: "N-30418", issueDate: "2026-11-06", lines: daiwaLines, subtotal: sum(daiwaLines), tax: tax10(sum(daiwaLines)), total: sum(daiwaLines) + tax10(sum(daiwaLines)), taxLabelRate: "10", confirmDaysAgo: 14 },
  {
    id: "D03", filename: "納品書_三和工具_数量単価不一致.pdf", kind: "delivery_note", render: "pdf", pattern: "金額不一致（数量×単価）", issuer: P.sanwa, recipient: RECIPIENT, number: "SW-D-0455", issueDate: "2026-11-16",
    lines: [sanwaLines[0], { ...sanwaLines[1], amount: 12800 }, sanwaLines[2]], subtotal: 49600 + 12800 + 5600, tax: tax10(49600 + 12800 + 5600), total: 49600 + 12800 + 5600 + tax10(49600 + 12800 + 5600), taxLabelRate: "10",
  },
  { id: "D04", filename: "納品書_グリーンテック設備_日付なし.pdf", kind: "delivery_note", render: "pdf", pattern: "必須項目欠落（納品日なし）", issuer: P.greentech, recipient: RECIPIENT, number: "GT-D-0770", issueDate: null, lines: greenLines, subtotal: sum(greenLines), tax: tax10(sum(greenLines)), total: sum(greenLines) + tax10(sum(greenLines)), taxLabelRate: "10" },
  { id: "D05", filename: "納品書_みどり運送_スキャン.png", kind: "delivery_note", render: "png_scan", pattern: "画像（スキャン）", issuer: P.midori, recipient: RECIPIENT, number: "MD-N-1107", issueDate: "2026-11-07", lines: [L("パレット回収", "8", "枚", 500), L("梱包資材回収", "1", "式", 3000)], subtotal: 7000, tax: 700, total: 7700, taxLabelRate: "10" },
  { id: "D06", filename: "納品書_北斗オフィスサプライ_明細22行.pdf", kind: "delivery_note", render: "pdf", pattern: "明細が多い（2ページ）", issuer: P.hokuto, recipient: RECIPIENT, number: "HK-N-26-1103", issueDate: "2026-11-03", lines: hokutoLines.slice(0, 22), subtotal: sum(hokutoLines.slice(0, 22)), tax: tax10(sum(hokutoLines.slice(0, 22))), total: sum(hokutoLines.slice(0, 22)) + tax10(sum(hokutoLines.slice(0, 22))), taxLabelRate: "10", linesPerPage: 15, confirmDaysAgo: 16 },
  { id: "D07", filename: "納品書_サンライズ印刷_数量のみ.pdf", kind: "delivery_note", render: "pdf", pattern: "金額の記載なし", issuer: P.sunrise, recipient: RECIPIENT, number: "SR-N-0098", issueDate: "2026-11-09", lines: [L("会社案内パンフレット A4 8P", "1000", "部", null), L("封筒 長3 社名入り", "2000", "枚", null)], subtotal: null, tax: null, total: null, taxLabelRate: null, notes: "請求書は月末締めで別途お送りします。", confirmDaysAgo: 11 },
  {
    id: "D08", filename: "納品書_丸栄食品_軽減税率.pdf", kind: "delivery_note", render: "pdf", pattern: "8%・10% 混在", issuer: P.maruei, recipient: RECIPIENT, number: "MF-N-7730", issueDate: "2026-11-15",
    lines: [L("※ 業務用コーヒー豆 1kg", "6", "袋", 2400, "8"), L("※ 緑茶ティーバッグ 100P", "10", "箱", 980, "8"), L("紙コップ 205ml 1000個", "2", "箱", 3200, "10")],
    subtotal: 30600, tax: 2576, total: 33176, breakdown: [{ rate: "8", base: 24200, tax: 1936 }, { rate: "10", base: 6400, tax: 640 }], taxLabelRate: null,
  },
  { id: "D09", filename: "納品書_あおば清掃_低解像度.jpg", kind: "delivery_note", render: "jpeg_low", pattern: "低解像度の画像", issuer: P.aoba, recipient: RECIPIENT, number: "AB-N-1120", issueDate: "2026-11-20", lines: [L("清掃用洗剤 業務用", "4", "本", 2800), L("モップ替え糸", "6", "枚", 900)], subtotal: 16600, tax: 1660, total: 18260, taxLabelRate: "10" },
  { id: "D10", filename: "納品書_グリーンテック設備_GT-D-0781.pdf", kind: "delivery_note", render: "pdf", pattern: "正常な納品書", issuer: P.greentech, recipient: RECIPIENT, number: "GT-D-0781", issueDate: "2026-11-19", lines: [L("換気扇 交換用", "3", "台", 12800), L("取付部材一式", "1", "式", 4200)], subtotal: 42600, tax: 4260, total: 46860, taxLabelRate: "10" },

  // ---------------- 3種類以外（不明になる） ----------------
  { id: "U01", filename: "見積書_ネクストウェブ.pdf", kind: "quote", render: "pdf", pattern: "対象外の書類（見積書）", issuer: P.nextweb, recipient: RECIPIENT, number: "Q-2026-118", issueDate: "2026-11-12", lines: [L("ECサイト構築", "1", "式", 680000)], subtotal: 680000, tax: 68000, total: 748000, taxLabelRate: "10" },
];
