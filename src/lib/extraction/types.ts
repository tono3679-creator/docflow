/**
 * 読取処理で使う型。
 * 座標はすべてページ左上を (0,0)、右下を (1,1) とした比率（表示倍率・解像度に依存しない）。
 */
export type Box = { x: number; y: number; w: number; h: number };

export type DocumentType = "invoice" | "receipt" | "delivery_note" | "unknown";

/** 原本の単語（OCR の単語、または PDF の文字情報を空白で区切ったもの） */
export type Word = {
  text: string;
  box: Box;
  /** OCR の信頼度 0〜1。PDF の文字情報は null（読み取りの不確かさがない） */
  conf: number | null;
};

export type TextSource = "pdf_text" | "ocr" | "none";

export type PageText = {
  page: number;
  /** 基準の大きさ（PDF はポイント、画像はピクセル） */
  width: number;
  height: number;
  source: TextSource;
  engine: string | null;
  words: Word[];
};

/** 行（同じ高さに並び、間が大きく空いていない単語のまとまり） */
export type Line = {
  id: string;
  page: number;
  /** 整形した文字（NFKC・日本語の間の空白を除く） */
  text: string;
  box: Box;
  /** text の各文字が、どの単語（page の words の添字）のどの文字から来たか。区切りの空白は -1 */
  charWord: number[];
  charOffset: number[];
  /** 同じ高さの行（表の行）をまとめる番号 */
  row: number;
};

/** 原本上の根拠（座標が分からなければ使わない） */
export type SourceRef = {
  page: number;
  box: Box;
  /** 原本の文字（整形後） */
  text: string;
  /** 根拠の文字の最低の信頼度（PDF の文字情報は null） */
  conf: number | null;
};

export type ExtractedField = {
  key: string;
  /** 明細の行番号（見出しの項目は null） */
  line: number | null;
  /** 整形した値（日付は YYYY-MM-DD、金額は円の整数）。読めなかったら null（推測で埋めない） */
  value: string | null;
  /** 原本の位置。特定できなければ null（架空の座標は作らない） */
  source: SourceRef | null;
  /** 同じ項目に別の値の記載があったとき、その値（矛盾の検出に使う） */
  conflicts?: { value: string; source: SourceRef | null }[];
  /** 値の解釈に失敗したときの原本の文字（日付の形式が不明など） */
  raw?: string | null;
};

export type ClassificationResult = {
  type: DocumentType;
  /** 種別ごとの得点（ルール）または LLM の判定 */
  scores: Partial<Record<Exclude<DocumentType, "unknown">, number>>;
  /** 判定の根拠（見つけた語など） */
  evidence: string[];
  method: "rules" | "llm";
};

export type LineItemBox = { index: number; page: number; box: Box };

export type ExtractionOutput = {
  documentType: DocumentType;
  classification: ClassificationResult;
  fields: ExtractedField[];
  lineItems: LineItemBox[];
  /** 金額の照合に使う、帳票の書き方の手がかり */
  context: DocumentContext;
  /** 処理の注意（LLM が失敗してルールに切り替えた、など） */
  notes: string[];
};

export type DocumentContext = {
  /** 原本から文字を読み取れたか */
  textFound: boolean;
  /** 税込（内税）の帳票か。分からなければ null */
  taxIncluded: boolean | null;
  /** 帳票に書かれた端数処理 */
  rounding: "floor" | "round" | "ceil" | null;
  /** 「消費税(10%)」など、帳票に書かれた税率 */
  statedRates: ("10" | "8")[];
  /** 軽減税率の印（※・軽減・8%）があるか */
  hasReducedMarker: boolean;
};
