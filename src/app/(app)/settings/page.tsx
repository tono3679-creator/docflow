import { Page } from "@/components/common/page";
import { PageHeader, Panel, SectionTitle } from "@/components/common/page-header";
import { MembersPanel } from "@/components/settings/members-panel";
import { SettingsForm } from "@/components/settings/settings-form";
import { asCurrentUser, requireUser } from "@/lib/auth";
import { listMembers, usageThisMonth } from "@/lib/data/settings";
import { can, ROLE_LABEL } from "@/lib/domain/labels";
import { aiEnv, serverEnv } from "@/lib/env";
import { formatNumber, formatYen } from "@/lib/format";

export const metadata = { title: "設定" };

const KIND_LABEL = { pdf_text: "PDF の文字の読み取り", ocr: "OCR", llm: "AI による項目の抽出" } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** 書類の取り扱い（どこで読み取り、外部に何を送るか） */
function DataPolicy({ llmActive, llmConfigured, llmMissing, model, ocrExternal }: { llmActive: boolean; llmConfigured: boolean; llmMissing: string[]; model: string; ocrExternal: boolean }) {
  return (
    <ul className="grid gap-2 px-5 py-4 text-sm">
      <li>ファイルは非公開で保存し、この組織のメンバーだけが見られます（公開 URL はありません）。</li>
      <li>{ocrExternal ? "画像の文字の読み取り（OCR）は Google Document AI を使います（管理者が環境変数で設定）。" : "画像の文字の読み取り（OCR）は、このシステムのサーバーの中で行います（外部に送りません）。"}</li>
      <li>
        外部の AI への送信：<span className="font-medium">{llmActive ? `する（${model}）` : "しない"}</span>。
        {llmActive
          ? "送るのは読み取った文字と位置だけで、画像は送りません。口座番号・電話番号は伏せて送ります。"
          : llmConfigured ? "管理者が下の設定で有効にすると、読み取った文字と位置を送って項目を取り出します。" : llmMissing.length > 0 ? `サーバーの設定（${llmMissing.join("・")}）が足りないため、規則で項目を取り出します。` : "サーバーに外部の AI の設定がないため、規則で項目を取り出します。"}
      </li>
      <li>AI が読み取れなかった項目は空欄（未取得）のままにし、推測で埋めません。</li>
    </ul>
  );
}

export default async function SettingsPage() {
  const user = await requireUser();
  const ai = aiEnv();
  const llmConfigured = ai.llmProvider === "anthropic";
  const llmActive = llmConfigured && user.settings.llmEnabled && !user.isDemo;
  const effectiveMb = Math.min(user.settings.maxFileMb, serverEnv.uploadBodyLimitMb);
  const s = user.settings;

  if (!can.settings(user.role)) {
    return (
      <Page>
        <PageHeader title="設定" sub={`${user.organizationName}・${user.displayName}（${ROLE_LABEL[user.role]}）`} />
        <SectionTitle>書類の取り扱い</SectionTitle>
        <Panel><DataPolicy llmActive={llmActive} llmConfigured={llmConfigured} llmMissing={ai.llmMissing} model={ai.llmModel} ocrExternal={ai.ocrProvider === "google-document-ai"} /></Panel>
        <SectionTitle className="mt-6">読み取りと確認</SectionTitle>
        <Panel>
          <dl className="divide-y px-5">
            <Row label="1ファイルの上限">{effectiveMb}MB・{s.maxPages}ページ</Row>
            <Row label="要確認にする信頼度">{Math.round(s.confidenceThreshold * 100)}% 未満</Row>
            <Row label="担当者が確定できる金額">{s.staffConfirmLimit === null ? "上限なし" : `${formatYen(s.staffConfirmLimit)} まで`}</Row>
          </dl>
        </Panel>
        <p className="mt-4 text-xs text-muted-foreground">設定は管理者が変更します。</p>
      </Page>
    );
  }

  const [members, usage] = await Promise.all([
    listMembers(user.organizationId),
    asCurrentUser((tx) => usageThisMonth(tx, s.timezone)),
  ]);

  return (
    <Page>
      <PageHeader title="設定" sub={user.organizationName} />
      <SettingsForm
        initial={{
          maxFileMb: s.maxFileMb,
          maxPages: s.maxPages,
          thresholdPercent: Math.round(s.confidenceThreshold * 100),
          staffConfirmLimit: s.staffConfirmLimit === null ? "" : String(s.staffConfirmLimit),
          llmEnabled: s.llmEnabled,
        }}
        serverLimitMb={serverEnv.uploadBodyLimitMb}
        llm={{ configured: llmConfigured, model: ai.llmModel, demo: user.isDemo }}
        policy={<DataPolicy llmActive={llmActive} llmConfigured={llmConfigured} llmMissing={ai.llmMissing} model={ai.llmModel} ocrExternal={ai.ocrProvider === "google-document-ai"} />}
      />

      <SectionTitle className="mt-8">メンバー</SectionTitle>
      <MembersPanel members={members} currentUserId={user.userId} isDemo={user.isDemo} />

      <SectionTitle className="mt-8">今月の読み取りの利用量</SectionTitle>
      <Panel>
        {usage.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">今月の読み取りはまだありません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-5 py-2 font-normal">方法</th>
                  <th scope="col" className="px-3 py-2 font-normal">提供元・モデル</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">回数</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">ページ</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">トークン（入力／出力）</th>
                  <th scope="col" className="px-5 py-2 text-right font-normal">失敗</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {usage.map((u) => (
                  <tr key={`${u.kind}-${u.provider}-${u.model}`}>
                    <td className="px-5 py-2">{KIND_LABEL[u.kind] ?? u.kind}</td>
                    <td className="px-3 py-2 text-muted-foreground">{u.provider}{u.model ? `・${u.model}` : ""}</td>
                    <td className="tabular px-3 py-2 text-right">{formatNumber(u.calls)}</td>
                    <td className="tabular px-3 py-2 text-right">{formatNumber(u.pages)}</td>
                    <td className="tabular px-3 py-2 text-right">{u.kind === "llm" ? `${formatNumber(u.input_tokens)}／${formatNumber(u.output_tokens)}` : "—"}</td>
                    <td className={`tabular px-5 py-2 text-right ${u.failures > 0 ? "text-danger-strong" : ""}`}>{formatNumber(u.failures)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t px-5 py-2.5 text-xs text-muted-foreground">料金は提供元の管理画面で確認してください（この画面は回数と量の記録です）。</p>
      </Panel>
    </Page>
  );
}
