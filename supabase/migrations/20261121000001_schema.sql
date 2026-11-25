-- DocFlow のスキーマ（表・型・index）
--
-- * すべての業務表に organization_id を持たせ、子の表は (organization_id, 親id) の複合外部キーで参照する。
--   別の会社の書類・項目を指す行は作れない。
-- * 金額は円の整数（bigint）。数量・単価は numeric（浮動小数点は使わない）。
-- * AI が読み取った値（extracted_value）は書き換えない。利用者が直した今の値は value、確定した値は confirmed_value。
-- * 座標（bounding_box）はページ左上を (0,0)、右下を (1,1) とした比率 {x,y,w,h}。表示倍率・回転に依存しない。
--   原本の位置を特定できなかった項目は null（架空の座標は入れない）。
-- * 書類のファイル本体は app_private.file_blobs（または Supabase Storage）。ログイン利用者からは直接読めない。

create schema if not exists app_private;
create schema if not exists app_auth;
revoke all on schema app_private from public;
revoke all on schema app_auth from public;

-- ---------------------------------------------------------------
-- 型
-- ---------------------------------------------------------------
-- admin：管理者 / staff：担当者 / viewer：閲覧者
create type public.org_role as enum ('admin', 'staff', 'viewer');
create type public.document_type as enum ('invoice', 'receipt', 'delivery_note', 'unknown');
-- queued：未処理 / processing：処理中 / needs_review：要確認 / ready：確定待ち（検証で問題なし）
-- confirmed：処理済み（確定） / error：エラー / excluded：除外（重複など）
create type public.document_status as enum ('queued', 'processing', 'needs_review', 'ready', 'confirmed', 'error', 'excluded');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
-- ok：検証上の問題なし（正しさの保証ではない） / needs_review：要確認 / inconsistent：不整合 / missing：未取得
create type public.validation_status as enum ('ok', 'needs_review', 'inconsistent', 'missing');
create type public.review_status as enum ('unreviewed', 'confirmed');
create type public.issue_severity as enum ('warning', 'error');
-- open：未対応 / resolved：解消（値の修正・確認で） / accepted：理由を付けて承認
create type public.issue_status as enum ('open', 'resolved', 'accepted');
create type public.duplicate_status as enum ('pending', 'not_duplicate', 'duplicate');

-- ---------------------------------------------------------------
-- ログインの利用者（Supabase Auth の auth.users と衝突しないよう app_auth に置く）
-- ---------------------------------------------------------------
create table app_auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index users_email_lower_idx on app_auth.users (lower(email)) where email is not null;

-- ---------------------------------------------------------------
-- 組織（テナント）
-- ---------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  is_demo boolean not null default false,
  demo_expires_at timestamptz,
  -- 見本の組織（メールアドレスとパスワードでログインする）
  is_showcase boolean not null default false,
  -- デモの元データ（誰もログインしない。訪問者ごとのデモはここから複製する）
  is_template boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_demo or demo_expires_at is not null)
);
create index organizations_demo_idx on public.organizations (demo_expires_at) where is_demo;

create table public.organization_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  timezone text not null default 'Asia/Tokyo' check (char_length(timezone) <= 50),
  -- アップロードの上限（実行環境・OCR の制限に合わせて 20MB・50ページまで）
  max_file_mb integer not null default 10 check (max_file_mb between 1 and 20),
  max_pages integer not null default 20 check (max_pages between 1 and 50),
  -- OCR の信頼度がこれ未満の文字を含む項目は「要確認」
  confidence_threshold numeric(3, 2) not null default 0.80 check (confidence_threshold between 0.50 and 0.99),
  -- 担当者が確定できる合計金額の上限（null なら上限なし）。超える書類は管理者が確定する
  staff_confirm_limit bigint check (staff_confirm_limit is null or staff_confirm_limit >= 0),
  -- 外部の AI（LLM）に書類の文字を送って項目を取り出すか。既定は送らない（管理者が取り扱いを確認して有効にする）
  llm_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references app_auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.org_role not null default 'viewer',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

-- ---------------------------------------------------------------
-- ファイル本体（内容の SHA-256 で1つだけ保存。どの組織の書類から参照されているかは documents が持つ）
-- ログイン利用者には権限を付けない。サーバーが documents を RLS 付きで読めたときだけ取り出す。
-- ---------------------------------------------------------------
create table app_private.file_blobs (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null,
  byte_size integer not null check (byte_size > 0),
  mime_type text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 書類
-- ---------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  uploaded_by uuid references public.profiles (id) on delete set null,
  filename text not null check (char_length(filename) between 1 and 200),
  file_type text not null check (file_type in ('pdf', 'png', 'jpeg', 'webp')),
  mime_type text not null,
  file_size integer not null check (file_size > 0),
  -- 'db:<sha256>' または 'supabase:<bucket>/<path>'
  storage_path text not null,
  -- 画像は向きを直した表示用の PNG（座標はこの画像が基準）。PDF は null
  preview_path text,
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  document_type public.document_type,
  -- ai：自動判定 / user：利用者が変更
  type_source text check (type_source in ('ai', 'user')),
  -- 判定の根拠（スコア・見つけた語）
  classification jsonb not null default '{}'::jsonb,
  status public.document_status not null default 'queued',
  page_count integer not null default 1 check (page_count between 1 and 200),
  -- 読取に使った方式（例：pdf_text+rules / ocr:tesseract+llm:anthropic）
  extraction_method text,
  -- デモの書類：読取結果は事前に処理して保存したもの
  is_sample boolean not null default false,
  -- 一覧・検索・重複判定のための写し（document_fields の今の値から作る）
  issuer_name text,
  document_number text,
  issue_date date,
  total_amount bigint,
  open_issue_count integer not null default 0,
  error_message text check (char_length(error_message) <= 500),
  batch_id uuid,
  -- 同時に編集したときの上書きを防ぐ版番号
  version integer not null default 1,
  uploaded_at timestamptz not null default now(),
  processed_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((status = 'confirmed') = (confirmed_at is not null))
);
create index documents_org_status_idx on public.documents (organization_id, status, uploaded_at desc);
create index documents_org_hash_idx on public.documents (organization_id, file_hash);
create index documents_org_number_idx on public.documents (organization_id, document_number) where document_number is not null;
create index documents_org_confirmed_idx on public.documents (organization_id, confirmed_at desc) where confirmed_at is not null;
create index documents_search_idx on public.documents using gin ((filename || ' ' || coalesce(issuer_name, '') || ' ' || coalesce(document_number, '')) extensions.gin_trgm_ops);

-- ページ（大きさと、読み取った文字の座標）
create table public.document_pages (
  organization_id uuid not null,
  document_id uuid not null,
  page_number integer not null check (page_number >= 1),
  -- 基準の大きさ（PDF はポイント、画像はピクセル）。座標は比率なので表示には使わない
  width numeric(10, 2) not null check (width > 0),
  height numeric(10, 2) not null check (height > 0),
  -- pdf_text：PDF の文字情報 / ocr：OCR / none：文字なし
  text_source text not null check (text_source in ('pdf_text', 'ocr', 'none')),
  ocr_engine text,
  -- 単語ごとの [文字, x, y, w, h, 信頼度(0〜1, PDF の文字は null)]
  words jsonb not null default '[]'::jsonb,
  mean_confidence numeric(4, 3),
  primary key (document_id, page_number),
  foreign key (organization_id, document_id) references public.documents (organization_id, id) on delete cascade
);

-- 読取の処理（キュー）。同じ書類で動いている処理は1つだけ（document_id の部分一意 index）
create table public.extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  document_id uuid not null,
  status public.job_status not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  -- この時刻を過ぎても終わらない処理は止まったとみなし、もう一度取り出す
  lease_until timestamptz,
  last_error text check (char_length(last_error) <= 1000),
  requested_by uuid references public.profiles (id) on delete set null,
  -- 利用者が書類種別を指定して読み直すとき
  forced_type public.document_type,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, document_id) references public.documents (organization_id, id) on delete cascade
);
create unique index extraction_jobs_active_idx on public.extraction_jobs (document_id) where status in ('queued', 'running');
create index extraction_jobs_queue_idx on public.extraction_jobs (status, run_after) where status in ('queued', 'running');

-- AI の読取結果（そのままの記録。書き換えない）
create table public.extraction_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  document_id uuid not null,
  job_id uuid references public.extraction_jobs (id) on delete set null,
  method text not null,
  ocr_provider text,
  llm_provider text,
  model text,
  -- デモ用に事前に処理して保存した結果
  is_precomputed boolean not null default false,
  document_type public.document_type not null,
  classification jsonb not null default '{}'::jsonb,
  output jsonb not null,
  duration_ms integer,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (organization_id, document_id) references public.documents (organization_id, id) on delete cascade
);
create index extraction_results_doc_idx on public.extraction_results (document_id, created_at desc);

-- 明細の行（行全体の位置）。行ごとの値は document_fields（line_index 付き）
create table public.document_line_items (
  organization_id uuid not null,
  document_id uuid not null,
  line_index integer not null check (line_index >= 0),
  page_number integer,
  bounding_box jsonb,
  primary key (document_id, line_index),
  foreign key (organization_id, document_id) references public.documents (organization_id, id) on delete cascade
);

-- 項目（見出しの項目は line_index が null、明細の値は行番号）
create table public.document_fields (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  document_id uuid not null,
  line_index integer check (line_index >= 0),
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  extracted_value text check (char_length(extracted_value) <= 1000),
  value text check (char_length(value) <= 1000),
  confirmed_value text,
  page_number integer check (page_number >= 1),
  bounding_box jsonb check (bounding_box is null or (
    jsonb_typeof(bounding_box -> 'x') = 'number' and jsonb_typeof(bounding_box -> 'y') = 'number'
    and jsonb_typeof(bounding_box -> 'w') = 'number' and jsonb_typeof(bounding_box -> 'h') = 'number')),
  -- 原本の文字の信頼度（OCR）。PDF の文字情報は null
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  source_text text check (char_length(source_text) <= 1000),
  -- 値の出どころ：pdf_text / ocr / user
  source text not null default 'ocr' check (source in ('pdf_text', 'ocr', 'user')),
  validation_status public.validation_status not null default 'ok',
  review_status public.review_status not null default 'unreviewed',
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, document_id) references public.documents (organization_id, id) on delete cascade,
  check ((bounding_box is null) = (page_number is null))
);
create unique index document_fields_key_idx on public.document_fields (document_id, coalesce(line_index, -1), field_key);

-- 検証で見つかった問題（issue_key で同じ問題を見分け、承認・解消の状態を引き継ぐ）
create table public.validation_issues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  document_id uuid not null,
  field_id uuid,
  issue_key text not null check (char_length(issue_key) <= 120),
  issue_type text not null check (issue_type in (
    'low_confidence', 'ambiguous', 'invalid_format', 'date_format', 'date_order', 'amount_mismatch', 'tax_mismatch',
    'unverifiable', 'missing_required', 'no_source', 'conflict', 'duplicate', 'type_unknown', 'read_failed')),
  severity public.issue_severity not null,
  reason text not null check (char_length(reason) between 1 and 200),
  detail jsonb not null default '{}'::jsonb,
  status public.issue_status not null default 'open',
  accept_reason text check (char_length(accept_reason) <= 300),
  resolved_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (document_id, issue_key),
  foreign key (organization_id, document_id) references public.documents (organization_id, id) on delete cascade,
  foreign key (organization_id, field_id) references public.document_fields (organization_id, id) on delete cascade,
  check (status <> 'accepted' or char_length(coalesce(accept_reason, '')) > 0)
);
create index validation_issues_doc_idx on public.validation_issues (document_id, status);

-- 確認・修正の記録（追記のみ）
create table public.review_actions (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  document_id uuid not null,
  field_id uuid,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (action in (
    'edit', 'confirm_field', 'unconfirm_field', 'accept_issue', 'reopen_issue', 'add_line', 'remove_line',
    'change_type', 'confirm_document', 'reopen_document', 'duplicate_decision', 'exclude', 'restore')),
  field_key text,
  line_index integer,
  before_value text,
  after_value text,
  reason text check (char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  foreign key (organization_id, document_id) references public.documents (organization_id, id) on delete cascade
);
create index review_actions_doc_idx on public.review_actions (document_id, created_at);

-- 確定の記録（確定するたびにその時点の値をすべて残す）
create table public.document_confirmations (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  document_id uuid not null,
  confirmed_by uuid references public.profiles (id) on delete set null,
  confirmed_at timestamptz not null default now(),
  snapshot jsonb not null,
  foreign key (organization_id, document_id) references public.documents (organization_id, id) on delete cascade
);

-- 重複の候補（自動では消さない。利用者が判断する）
create table public.duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  document_id uuid not null,
  other_document_id uuid not null,
  -- exact_file：同じファイル / same_number：同じ番号 / similar：発行元・日付・金額が同じ
  kind text not null check (kind in ('exact_file', 'same_number', 'similar')),
  matched jsonb not null default '{}'::jsonb,
  status public.duplicate_status not null default 'pending',
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (document_id, other_document_id),
  foreign key (organization_id, document_id) references public.documents (organization_id, id) on delete cascade,
  foreign key (organization_id, other_document_id) references public.documents (organization_id, id) on delete cascade,
  check (document_id <> other_document_id)
);

-- 出力の記録
create table public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  requested_by uuid references public.profiles (id) on delete set null,
  format text not null check (format in ('xlsx', 'csv')),
  target text not null check (target in ('invoice', 'receipt', 'delivery_note', 'lines', 'all')),
  document_ids uuid[] not null,
  row_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index export_jobs_org_idx on public.export_jobs (organization_id, created_at desc);

-- 操作の記録
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null,
  entity text not null,
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_id, created_at);

-- AI・OCR の利用量（費用の把握）
create table public.ai_usage_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  document_id uuid,
  kind text not null check (kind in ('pdf_text', 'ocr', 'llm')),
  provider text not null,
  model text,
  pages integer not null default 0,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  success boolean not null,
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now()
);
create index ai_usage_logs_org_idx on public.ai_usage_logs (organization_id, created_at desc);
