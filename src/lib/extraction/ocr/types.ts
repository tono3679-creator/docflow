import type { PageText } from "../types";

/** OCR の差し替え口。どのエンジンも「単語・座標（比率）・信頼度」を返す */
export interface OcrProvider {
  readonly name: string;
  readonly engine: string;
  /** 画像（PNG）1ページ分を読み取る */
  recognize(image: Buffer, size: { width: number; height: number }, page: number): Promise<PageText>;
}

export class OcrError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
    this.name = "OcrError";
  }
}
