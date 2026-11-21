import "server-only";
/**
 * Claude（Anthropic API）による書類種別の判定と項目抽出。
 * 構造化出力（output_config.format＋Zod）で形を固定し、受け取った JSON も Zod で検証する。
 * 形が正しくない・拒否された・失敗したときは LlmError（呼び出し側でリトライ／ルール抽出へ切り替え）。
 * ※ この開発環境では API キーを使った実際の呼び出しは未確認（テストは応答を模擬して確認）。
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LlmOutput, SYSTEM_PROMPT, type LlmOutputT } from "./prompt";

export class LlmError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
    this.name = "LlmError";
  }
}

export type LlmUsage = { inputTokens: number | null; outputTokens: number | null };

export interface LlmExtractor {
  readonly provider: string;
  readonly model: string;
  extract(documentText: string, options: { forcedType: string | null; signal?: AbortSignal }): Promise<{ output: LlmOutputT; usage: LlmUsage }>;
}

export class AnthropicExtractor implements LlmExtractor {
  readonly provider = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async extract(documentText: string, options: { forcedType: string | null; signal?: AbortSignal }) {
    const hint = options.forcedType ? `\n書類種別は利用者が「${options.forcedType}」と指定しています。document_type はこれにしてください。` : "";
    try {
      const response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: 16000,
          output_config: { effort: "medium", format: zodOutputFormat(LlmOutput) },
          system: SYSTEM_PROMPT + hint,
          messages: [{ role: "user", content: `<document>\n${documentText}\n</document>` }],
        },
        { signal: options.signal },
      );
      if (response.stop_reason === "refusal") throw new LlmError("AI が処理を断りました", false);
      if (response.stop_reason === "max_tokens") throw new LlmError("AI の応答が長すぎて途中で切れました", false);
      const parsed = LlmOutput.safeParse(response.parsed_output);
      if (!parsed.success) throw new LlmError("AI の応答の形式が正しくありません", true);
      return {
        output: parsed.data,
        usage: { inputTokens: response.usage.input_tokens ?? null, outputTokens: response.usage.output_tokens ?? null },
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (e instanceof Anthropic.AuthenticationError) throw new LlmError("AI の API キーが正しくありません", false);
      if (e instanceof Anthropic.BadRequestError) throw new LlmError(`AI への依頼が受け付けられません：${e.message}`.slice(0, 300), false);
      if (e instanceof Anthropic.RateLimitError) throw new LlmError("AI の利用上限に達しました", true);
      if (e instanceof Anthropic.APIError) throw new LlmError(`AI の処理に失敗しました（${e.status ?? "接続"}）`, true);
      throw new LlmError(`AI の処理に失敗しました：${e instanceof Error ? e.message : String(e)}`.slice(0, 300), true);
    }
  }
}
