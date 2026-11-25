# 公開の手順（Vercel ＋ Neon）

GitHub Pages では動きません（サーバーと DB が必要です）。データベースは Vercel の画面からつなげる Neon（PostgreSQL）を使います。Supabase の PostgreSQL でも同じように動きます（下の「Supabase を使う場合」）。

## 1. 最小の公開（外部の AI・OCR を使わない）

追加の費用はかかりません（Vercel・Neon の無料プランの範囲）。OCR はサーバー内の Tesseract で動きます。

1. [Vercel](https://vercel.com/new) でこのリポジトリをインポート（Framework は Next.js のまま）。
2. **Environment Variables** に2つ登録して **Deploy**。
   | 名前 | 値 |
   | --- | --- |
   | `SEED_LOGIN_PASSWORD` | 見本の会社のログイン用パスワード（12文字以上・自分で決める） |
   | `CRON_SECRET` | 16文字以上のランダムな文字列（毎日の定期処理用） |
3. 初回のビルドは `DATABASE_URL` が無いので失敗します（想定どおり）。
4. プロジェクトの **Storage → Create Database → Neon** を選ぶ。Region は **Singapore**、プランは Free。**Connect Project** で Production と Preview にチェックし、Custom Prefix は空のまま。`DATABASE_URL` と `DATABASE_URL_UNPOOLED` が自動で入ります。
5. **Deployments** で最新のものを **Redeploy**。本番のビルドでだけ、マイグレーション → 見本の会社とデモの元データの作成 が自動で行われます（`scripts/deploy/vercel-build.ts`）。プレビューのビルドでは DB を変更しません。
6. 公開した URL を開き、「デモを試す」で動くことを確かめます。

- 毎日 3:00（日本時間）に、期限切れのデモの削除と、止まった読み取りの再開が行われます（`vercel.json` の Cron）。
- Vercel の関数は Neon と同じシンガポール（`sin1`）で動かします。
- Vercel の関数は1回の送信が 4.5MB までのため、1ファイルの上限は 4MB になります（設定画面の値と小さい方）。
- 公開後は GitHub Actions の **公開環境の E2E テスト**（`production-e2e.yml`、入力に公開 URL）で、公開環境に対して E2E を実行できます。

## 2. 外部の AI で項目を取り出す（任意・有料）

規則の抽出で動くので必須ではありません。使うと、ラベルの書き方が独特な書類でも項目を取り出しやすくなります。

1. [Anthropic Console](https://console.anthropic.com/) でアカウントを作り、**Billing** で支払い方法とクレジットを登録する。
2. **API Keys → Create Key** でキーを作る（作成時に一度だけ表示されます）。
3. Vercel の **Settings → Environment Variables** に登録して **Redeploy**。
   | 名前 | 値 |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | 作ったキー（`NEXT_PUBLIC_` を付けない） |
   | `LLM_MODEL` | 使うモデルの ID（Anthropic のドキュメントの「Models」の一覧から選ぶ） |
4. 管理者でログインし、**設定 → 外部の AI で項目を取り出す** をオンにして保存。オンにした組織の書類だけが送られます（デモ環境では使えません）。

- 送るのは読み取った文字と位置だけで、画像は送りません。口座番号・電話番号は伏せます。
- 回数・トークンは **設定 → 今月の読み取りの利用量** に出ます。料金は Anthropic Console で確認してください。
- 実際の取引先の書類を送ってよいか、社内の取り扱いを確認してからオンにしてください。

## 3. Google Document AI で OCR する（任意・有料）

既定の Tesseract（サーバー内）で動くので必須ではありません。画像・スキャン PDF が外部（Google Cloud）に送られます。

1. Google Cloud でプロジェクトを作り、課金を有効にする。**Document AI API** を有効にする。
2. **Document AI → プロセッサを作成 → Document OCR**（リージョン us または eu）。プロセッサの名前（`projects/…/locations/…/processors/…`）を控える。
3. **IAM → サービスアカウント** を作り、ロール「Document AI API ユーザー」を付ける。**鍵 → JSON** を作ってダウンロード。
4. Vercel の Environment Variables に登録して Redeploy。
   | 名前 | 値 |
   | --- | --- |
   | `OCR_PROVIDER` | `google-document-ai` |
   | `GOOGLE_DOCUMENT_AI_PROCESSOR` | 2. のプロセッサの名前 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | 3. の JSON の中身（1行のまま貼り付け） |

## Supabase を使う場合

- `DATABASE_URL` に Supabase の **Transaction pooler**（ポート 6543）、`DATABASE_URL_UNPOOLED` に **Session pooler**（ポート 5432）の接続文字列を登録します。`vercel.json` の `regions` は `hnd1`（東京）に変えてください。
- 書類のファイルを Supabase Storage に置きたい場合だけ、非公開のバケット `documents` を作り、`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY`（強い権限を持つ秘密の値。`NEXT_PUBLIC_` を付けない）を登録します。登録しなければ DB の非公開の表に保存します。

## 環境変数の一覧

[.env.example](../.env.example) を参照してください。すべてサーバー専用です（`NEXT_PUBLIC_` は使いません）。
