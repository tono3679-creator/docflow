# DocFlow の設計

## 方針

1. **推測で埋めない**：原本に根拠のない値は入れない（未取得のまま示す）。AI の出力も、原本の文字に根拠があるものだけを使う。
2. **間違った位置に印を出さない**：原本の位置（座標）が分かる項目にだけ印を付ける。分からなければ「印を付けていない」と知らせる。
3. **人が確定する**：どの書類も自動では確定しない。確定はサーバーの DB 関数が「保存された検証結果」を見て判断する。
4. **組織ごとに分ける**：すべての表に `organization_id` を持ち、RLS とDB 関数で他の組織の書類が見えない・触れないようにする。
5. **デモと本物を混ぜない**：デモの書類は「事前処理の結果」と画面に示し、訪問者ごとに別の組織を作る。

## 全体の流れ

```
ブラウザ ─ アップロード（1ファイルずつ）→ /api/documents/upload
                                           ├ 形式・大きさ・ページ数・スクリプト・添付の確認
                                           ├ ファイルを保存（非公開）・register_document（DB 関数）→ 書類と処理のキュー
                                           └ after() で worker を動かす（応答は先に返す）
worker（src/lib/jobs/worker.ts）
  claimJobs（FOR UPDATE SKIP LOCKED・期限付き）→ readDocument（PDF の文字 or OCR）→ analyzePages（種別・項目・検証）
  → 1件ずつ別のトランザクションで保存（失敗しても他の書類に影響しない）
ブラウザ ─ /api/documents/status を数秒ごとに確認（処理中のものがあれば、そこでも worker を動かす）
確認画面 ─ 修正・確認・承認は画面の中にためて「保存」で apply_review_changes → 検証をやり直して sync_validation
          「確定」で confirm_document（未確認の確認事項・重複の疑い・金額の上限・版番号を DB で確かめる）
```

Vercel のような関数の実行時間に上限がある環境で動くよう、専用の常駐プロセスは使いません。アップロードと状態の確認のたびに、時間を区切って（45 秒）キューを進めます。画面を閉じて止まった処理は、次の確認・毎日の定期処理（`/api/cron/daily`）で続きから進めます。同時に動かす数は `EXTRACTION_CONCURRENCY` で抑えます。

## 読み取り（src/lib/extraction）

| 段階 | 内容 |
| --- | --- |
| 形式の判定 `file-type.ts` | 拡張子ではなく先頭のバイトで PDF・PNG・JPEG・WebP を判定 |
| PDF `pdf.ts` | pdf.js（XFA 無効・スクリプトは実行しない）。スクリプト（OpenAction・Names の JavaScript・ページの操作）と添付ファイルがあれば受け付けない。文字情報があればその単語と座標を使う（OCR より優先） |
| 画像 `image.ts` | sharp。4,000万画素を超える画像は展開せずに断る（圧縮爆弾対策）。写真の向き（EXIF）を直し、位置情報などのメタデータを消した PNG にしてから OCR（表示も同じ PNG を使うので座標がずれない） |
| OCR `ocr/` | 既定は tesseract.js（日本語 best_int、サーバー内）。単語ごとの座標と信頼度を返す。Google Document AI にも切り替え可能 |
| 行の組み立て `layout.ts` | 単語を行にまとめ、全角・半角・桁区切りを正規化 |
| 種別の判定 `classify.ts` | 見出し（請求書・領収書・納品書）と語句の点数。点差が小さい・見積書などのときは「不明」 |
| 項目の抽出 `rules-extractor.ts` | ラベル（「合計」「発行日」など）の右・下にある値を、項目の型（金額・日付・番号・会社名）に合うものだけ取る。明細は表の見出しの列の位置から読む。候補が複数あれば「矛盾」として記録 |
| AI（任意）`llm/` | 読み取った行を JSON で渡し、構造化出力（zod のスキーマ）で受け取る。原本に根拠が見つからない値・食い違う値は捨てる（`grounding.ts`・`llm/map.ts`）。同じ文字が原本に複数あるときは値を使うが、位置は特定しない |

座標はすべて**ページに対する 0〜1 の割合**（左上が原点・回転前）で保存します。画面では拡大率と回転に合わせて変換します（`src/lib/viewer/coords.ts`。CSS の変換と一致することを単体テストで確認）。

## 検証（src/lib/validation）

- `values.ts`：金額・日付・登録番号（T＋13桁）・税率の正規化と形式の確認。
- `reconcile.ts`：数量×単価＝金額、明細の合計＝小計（値引き・送料も考慮）、税率ごとの消費税（税率ごとに合計してから1回だけ端数処理）、小計＋消費税＝合計。端数処理（切り捨て・切り上げ・四捨五入）は書類に書いていなければどれでも可。どれも「一致・不一致・検証不能（値が足りない）」を返す。金額は円の整数、数量・単価は 1/1000 単位の整数（BigInt）で計算し、小数の誤差を出さない。
- `validate.ts`：必須項目・形式・日付の前後・OCR の信頼度（組織の設定、既定 80% 未満）・原本の位置なし・矛盾 から、項目の状態（正常・要確認・不整合・未取得）と確認事項を作る。確認事項には関係する値から作った `sig` を付け、承認した後に値が変わったら承認を取り消す。
- `duplicates.ts`：同じファイル（SHA-256）、または同じ発行元＋番号、または同じ発行元＋発行日＋合計。発行元は「株式会社」「㈱」などを外して比べる。自動では消さず、「重複として除外／重複ではない」を人が選ぶ。

## データベース（supabase/migrations）

| 表 | 内容 |
| --- | --- |
| organizations / organization_settings / organization_members / profiles | 組織・設定・メンバーと役割（admin・staff・viewer） |
| documents | 書類（状態・種別・要約の値・版番号 `version`・未確認の確認事項の数） |
| document_pages / extraction_results | ページの大きさ・文字（単語と座標）、読み取りの方式・メモ |
| document_fields / document_line_items | 項目（値・読み取った値・確定した値・座標・信頼度・検証の状態・確認の状態） |
| validation_issues / duplicate_candidates | 確認事項（未確認・承認・解消）、重複の疑い |
| review_actions / document_confirmations | 修正・確認・承認の履歴、確定したときの値の記録 |
| extraction_jobs | 読み取りの処理のキュー（同じ書類で動く処理は1つだけ：部分一意インデックス） |
| export_jobs / audit_logs / ai_usage_logs | 出力の記録・操作の記録・読み取りの利用量 |
| app_private.file_blobs | ファイル本体（利用者の権限では読めない） |
| app_auth.users / sessions / rate_limits | ログイン（scrypt）・セッション（Cookie には乱数、DB には SHA-256）・回数制限 |

### 書き込みは DB 関数だけ

ログイン利用者（`authenticated` ロール）には、業務の表の **SELECT だけ**を許可し、書き込みは `security definer` の関数で行います。関数は最初に `require_role` で役割を確かめ、`lock_document` で自分の組織の書類を行ロックしてから、状態・版番号を確かめます。

| 関数 | 役割 | 主な確認 |
| --- | --- | --- |
| register_document / request_extraction | admin・staff | ファイルの上限・ページ数、確定済みは読み直せない、処理中なら同じ処理を返す |
| apply_review_changes | admin・staff | 版番号（古ければ 40001）、確定済みは直せない、値を直すと未確認に戻る、承認には理由 |
| sync_validation | admin・staff | サーバーが計算した検証結果を保存（承認の `sig` を比べて引き継ぐ） |
| confirm_document | admin・staff | 版番号、未確認の確認事項なし、重複の疑いを判断済み、種別が決まっている、担当者は設定の金額まで |
| reopen_document / set_document_excluded / decide_duplicate | admin・staff | 理由が必要（再確認・除外） |
| delete_document | admin | |
| update_org_settings / update_member / admin_add_member | admin | デモでは外部の AI・メンバーの追加は不可、自分の役割は変えられない、管理者が0人になる変更はトリガーで拒否 |

### RLS

- どの表も `organization_id = current_org_id()` の行だけ読める。`current_org_id()` は「有効なメンバー」であることを確かめ、組織の切り替え（JWT の `org_id`）も所属している組織に限る。
- 操作の記録は、管理者は組織のすべて、ほかの人は書類に関するものだけ。利用量は管理者だけ。
- アプリはトランザクションごとに `set_config('role','authenticated')` と JWT の内容を設定して実行する（`src/lib/db/rls.ts`）ので、アプリの不具合で絞り込みを忘れても他の組織の行は返らない。

DB だけで守られていることを `tests/db/security.test.ts` で確かめています（他の組織の書類を ID 指定で読めない・操作できない、表へ直接書き込めない、閲覧者・担当者の制限、確定の条件、版番号、管理者の保護、デモの制限）。

## セキュリティ

- **ファイル**：非公開で保存し、`/api/documents/[id]/file` で RLS 付きで書類を読めたときだけ返す（`Content-Disposition`・`nosniff`・`sandbox` の CSP）。公開 URL は無い。
- **悪意のあるファイル**：中身で形式を判定、PDF のスクリプト・添付ファイル・パスワード・破損、画像の破損・巨大な画像を拒否（`tests/unit/malicious-files.test.ts`）。pdf.js はスクリプトを実行しない設定で開く。
- **画面**：CSP（nonce・`strict-dynamic`）、`X-Frame-Options`、Server Actions の入力は zod で検証。
- **出力**：Excel・CSV とも、`= + - @` で始まる値は先頭に `'` を付けて数式にしない。
- **ログイン**：scrypt、HttpOnly・SameSite=Lax の Cookie、失敗の回数制限。デモの作成・デモのアップロードも回数制限。
- **AI**：API キーはサーバーの環境変数だけ。送る前に口座番号・電話番号を伏せる。書類の文字はデータとして扱うよう指示し、出力はスキーマで検証、原本に根拠のない値は捨てる。デモ環境では使わない。

## デモ

- `npm run demo:generate`：架空の書類 37 件（PDF 26・スキャン画像など 11）と正解（`demo/ground-truth.json`）を作る。誤り・不鮮明・日付なし・税額の不一致・数量×単価の不一致・再送（重複）・読み取れない画像・見積書（種別不明）などを含む。
- `npm run demo:process`：実際の読み取り処理にかけ、結果を `demo/results` に保存。`npm run demo:evaluate` で正解と比べ `docs/ACCURACY.md` を作る。
- `db:seed`：元データ（is_template）の組織に結果を読み込み、15 件を確定済みにする。見本の組織（メールアドレスでログイン）はその複製。
- 「デモを試す」：元データを丸ごと複製した組織（is_demo、24時間）を作り、匿名の利用者でログイン。期限切れは毎日の定期処理で消す。

## 画面

- 色：背景 #FAFAF9・面 #FFFFFF・文字 #18181B・補助 #71717A・線 #E4E4E7、強調は落ち着いた青。黄＝要確認・赤＝不整合・緑＝確認済み・青＝選択中。色だけに頼らず、文字（正常・要確認・不整合・確認済み・未取得）とアイコンを併記。
- 確認画面（PC）：原本 55%・項目 45%。画面の高さに合わせ、左右それぞれがスクロール。操作のボタン（前の書類・次の要確認・保存・確定）は下に固定。
- 確認画面（スマートフォン）：「原本／項目」のタブ。項目の「原本で見る」で原本のタブに切り替えて位置を示す。操作のボタンは下のメニューの上に固定。
- Ctrl+S で保存。保存していない変更があれば、画面を離れる前に確認する。
