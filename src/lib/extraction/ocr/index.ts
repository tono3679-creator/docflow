import "server-only";
import { aiEnv } from "@/lib/env";
import { DocumentAiOcr } from "./document-ai";
import { TesseractOcr } from "./tesseract";
import type { OcrProvider } from "./types";

let provider: OcrProvider | null = null;

/** 設定（OCR_PROVIDER）に合わせた OCR。既定は Tesseract（外部に送信しない） */
export function ocrProvider(): OcrProvider {
  if (provider) return provider;
  const env = aiEnv();
  if (env.ocrProvider === "google-document-ai") {
    if (!env.googleProcessor || !env.googleKeyJson) {
      throw new Error("OCR_PROVIDER=google-document-ai には GOOGLE_DOCUMENT_AI_PROCESSOR と GOOGLE_SERVICE_ACCOUNT_JSON が必要です");
    }
    provider = new DocumentAiOcr(env.googleProcessor, env.googleKeyJson);
  } else {
    provider = new TesseractOcr();
  }
  return provider;
}

export function setOcrProviderForTests(p: OcrProvider | null) {
  provider = p;
}
