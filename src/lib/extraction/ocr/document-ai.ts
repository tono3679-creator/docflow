import "server-only";
/**
 * Google Cloud Document AI（Enterprise Document OCR）による OCR。
 * 設定（環境変数）：OCR_PROVIDER=google-document-ai、GOOGLE_DOCUMENT_AI_PROCESSOR（projects/…/locations/…/processors/…）、
 *                   GOOGLE_SERVICE_ACCOUNT_JSON（サービスアカウントの鍵 JSON）
 * トークン単位の座標（normalizedVertices）と信頼度を使う。
 * ※ この開発環境からは Google Cloud に接続できないため、実際の API での動作は未確認（README に記載）。
 */
import { createSign } from "node:crypto";
import { z } from "zod";
import { clampBox } from "../geometry";
import type { PageText, Word } from "../types";
import { OcrError, type OcrProvider } from "./types";

const KeySchema = z.object({ client_email: z.string(), private_key: z.string() });

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(keyJson: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const key = KeySchema.parse(JSON.parse(keyJson));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) throw new OcrError(`Google の認証に失敗しました（${res.status}）`, res.status >= 500);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

const Vertex = z.object({ x: z.number().optional(), y: z.number().optional() });
const Layout = z.object({
  textAnchor: z.object({ textSegments: z.array(z.object({ startIndex: z.coerce.number().optional(), endIndex: z.coerce.number() })).optional() }).optional(),
  confidence: z.number().optional(),
  boundingPoly: z.object({ normalizedVertices: z.array(Vertex).optional() }).optional(),
});
const ResponseSchema = z.object({
  document: z.object({
    text: z.string().default(""),
    pages: z.array(z.object({ tokens: z.array(z.object({ layout: Layout })).default([]) })).default([]),
  }),
});

export class DocumentAiOcr implements OcrProvider {
  readonly name = "google-document-ai";
  readonly engine = "Google Document AI";

  constructor(private processor: string, private keyJson: string) {}

  async recognize(image: Buffer, size: { width: number; height: number }, page: number): Promise<PageText> {
    const location = /locations\/([^/]+)/.exec(this.processor)?.[1] ?? "us";
    const res = await fetch(`https://${location}-documentai.googleapis.com/v1/${this.processor}:process`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken(this.keyJson)}`, "content-type": "application/json" },
      body: JSON.stringify({ rawDocument: { content: image.toString("base64"), mimeType: "image/png" }, skipHumanReview: true }),
    });
    if (!res.ok) throw new OcrError(`Document AI の処理に失敗しました（${res.status}）`, res.status === 429 || res.status >= 500);
    const parsed = ResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new OcrError("Document AI の応答の形式が想定と違います", false);
    const { text, pages } = parsed.data.document;
    const words: Word[] = [];
    for (const token of pages[0]?.tokens ?? []) {
      const seg = token.layout.textAnchor?.textSegments?.[0];
      const vs = token.layout.boundingPoly?.normalizedVertices ?? [];
      if (!seg || vs.length < 3) continue;
      const t = text.slice(seg.startIndex ?? 0, seg.endIndex).trim();
      if (!t) continue;
      const xs = vs.map((v) => v.x ?? 0);
      const ys = vs.map((v) => v.y ?? 0);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      if (x1 <= x0 || y1 <= y0) continue;
      words.push({ text: t, box: clampBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), conf: token.layout.confidence ?? null });
    }
    return { page, width: size.width, height: size.height, source: words.length > 0 ? "ocr" : "none", engine: this.engine, words };
  }
}
