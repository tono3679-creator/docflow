import "server-only";

/** サーバー専用の環境変数。足りなければ使うときに分かるようにする。 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません（.env.example を参照）`);
  return value;
}

function positiveInt(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

export const serverEnv = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get cronSecret() {
    return process.env.CRON_SECRET ?? "";
  },
  /** 同時に存在できるデモ組織の上限 */
  get demoMaxActive() {
    return positiveInt("DEMO_MAX_ACTIVE", 40);
  },
  /** 同じ接続元から1時間に作れるデモ環境の数（大量作成の対策） */
  get demoCreateLimitPerHour() {
    return positiveInt("DEMO_CREATE_LIMIT_PER_HOUR", 30);
  },
  /** デモ環境で1時間にアップロードできるファイルの数（OCR の負荷の対策） */
  get demoUploadLimitPerHour() {
    return positiveInt("DEMO_UPLOAD_LIMIT_PER_HOUR", 20);
  },
  /**
   * 1回の送信で受け取れる大きさ（MB）。Vercel の関数は要求の本文が 4.5MB までなので、Vercel では既定 4MB。
   * 組織の設定（最大ファイルサイズ）とこの値の小さい方が、1ファイルの上限になる。
   */
  get uploadBodyLimitMb() {
    return positiveInt("UPLOAD_BODY_LIMIT_MB", process.env.VERCEL ? 4 : 20, 20);
  },
};

export type LlmProviderName = "none" | "anthropic";
export type OcrProviderName = "tesseract" | "google-document-ai";

/**
 * 読取（OCR・AI）の設定。API キーはサーバーの環境変数だけに置き、ブラウザには送らない。
 *   OCR_PROVIDER         tesseract（既定・外部送信なし） / google-document-ai
 *   LLM_PROVIDER         none（既定・ルール抽出） / anthropic（ANTHROPIC_API_KEY と LLM_MODEL が必要）
 *   LLM_MODEL            使うモデルの ID（Anthropic のモデル一覧から選ぶ。未設定なら AI は使わない）
 *   EXTRACTION_CONCURRENCY  同時に動かす読取処理の数（既定 2）
 *   EXTRACTION_MAX_ATTEMPTS 失敗したときに試す回数（既定 3）
 *   EXTRACTION_TIMEOUT_SECONDS 1ファイルの処理の上限（既定 50 秒）
 */
export function aiEnv() {
  const requested = (process.env.LLM_PROVIDER ?? "").trim() || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "none");
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const model = process.env.LLM_MODEL?.trim() ?? "";
  // キーとモデルの両方がそろったときだけ使う（片方だけなら使わず、設定画面で足りないものを示す）
  const llm = requested === "anthropic" && apiKey && model ? "anthropic" : "none";
  const llmMissing = requested === "anthropic" ? [!apiKey && "ANTHROPIC_API_KEY", !model && "LLM_MODEL"].filter((x): x is string => !!x) : [];
  return {
    ocrProvider: (process.env.OCR_PROVIDER === "google-document-ai" ? "google-document-ai" : "tesseract") as OcrProviderName,
    googleProcessor: process.env.GOOGLE_DOCUMENT_AI_PROCESSOR ?? "",
    googleKeyJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "",
    llmProvider: (llm === "anthropic" ? "anthropic" : "none") as LlmProviderName,
    anthropicApiKey: apiKey,
    llmModel: model,
    /** 外部の AI を使うつもりで足りない環境変数（設定画面に出す） */
    llmMissing,
    /** LLM が失敗したとき、ルール抽出に切り替える（既定 true） */
    llmFallbackToRules: process.env.LLM_FALLBACK_TO_RULES !== "false",
    /** LLM に送る前に口座番号・電話番号を伏せる（既定 true） */
    llmMaskSensitive: process.env.LLM_MASK_SENSITIVE !== "false",
    concurrency: positiveInt("EXTRACTION_CONCURRENCY", 2, 10),
    maxAttempts: positiveInt("EXTRACTION_MAX_ATTEMPTS", 3, 10),
    timeoutSeconds: positiveInt("EXTRACTION_TIMEOUT_SECONDS", 50, 280),
  };
}

/**
 * Supabase Storage（任意）。両方あれば、書類のファイルを非公開のバケット documents に保存する（無ければ DB に保存）。
 * サービスロールキーはサーバーだけで使う（NEXT_PUBLIC_ を付けない・ブラウザに送らない）。
 */
export const storageEnv = {
  get url() {
    return (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  },
  get serviceRoleKey() {
    return process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  },
  get enabled() {
    return !!this.url && !!this.serviceRoleKey;
  },
};
