"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Panel, SectionTitle } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateSettings, type SettingsInput } from "@/lib/actions/settings";
import { safeAction } from "@/lib/client/safe-action";
import { cn } from "@/lib/utils";

type Values = { maxFileMb: number; maxPages: number; thresholdPercent: number; staffConfirmLimit: string; llmEnabled: boolean };

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: React.ReactNode; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 py-3 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-start sm:gap-4">
      <label htmlFor={id} className="pt-2 text-sm font-medium">{label}</label>
      <div>
        {children}
        {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export function SettingsForm({ initial, serverLimitMb, llm, policy }: {
  initial: Values;
  serverLimitMb: number;
  llm: { configured: boolean; model: string; demo: boolean };
  policy: React.ReactNode;
}) {
  const router = useRouter();
  const [v, setV] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const set = <K extends keyof Values>(k: K, value: Values[K]) => setV((cur) => ({ ...cur, [k]: value }));

  const save = async () => {
    setBusy(true);
    const res = await safeAction(() => updateSettings(v as SettingsInput));
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    setErrors({});
    toast.success("設定を保存しました");
    router.refresh();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      noValidate
    >
      <SectionTitle>読み取りと確認</SectionTitle>
      <Panel>
        <div className="divide-y px-5">
          <Field id="maxFileMb" label="1ファイルの上限（MB）" error={errors.maxFileMb} hint={serverLimitMb < v.maxFileMb ? `このサーバーでは ${serverLimitMb}MB までになります（ホスティングの送信サイズの上限）` : "1〜20MB"}>
            <Input id="maxFileMb" type="number" inputMode="numeric" min={1} max={20} className="w-28" value={v.maxFileMb} onChange={(e) => set("maxFileMb", Number(e.target.value))} />
          </Field>
          <Field id="maxPages" label="1ファイルのページ数の上限" error={errors.maxPages} hint="1〜50ページ">
            <Input id="maxPages" type="number" inputMode="numeric" min={1} max={50} className="w-28" value={v.maxPages} onChange={(e) => set("maxPages", Number(e.target.value))} />
          </Field>
          <Field id="threshold" label="要確認にする信頼度（%未満）" error={errors.thresholdPercent} hint="OCR の信頼度がこれ未満の文字を含む項目を「要確認」にします（50〜99）。上げるほど確認が増えます">
            <Input id="threshold" type="number" inputMode="numeric" min={50} max={99} className="w-28" value={v.thresholdPercent} onChange={(e) => set("thresholdPercent", Number(e.target.value))} />
          </Field>
          <Field id="staffLimit" label="担当者が確定できる合計金額（円）" error={errors.staffConfirmLimit} hint="空欄なら上限なし。超える書類は管理者が確定します">
            <Input id="staffLimit" inputMode="numeric" className="w-40" placeholder="上限なし" value={v.staffConfirmLimit} onChange={(e) => set("staffConfirmLimit", e.target.value.replace(/[,，\s]/g, ""))} />
          </Field>
        </div>
      </Panel>

      <SectionTitle className="mt-8">書類の取り扱いと外部の AI</SectionTitle>
      <Panel>
        {policy}
        <div className="border-t px-5 py-4">
          <label className={cn("flex items-start gap-3", (llm.demo || !llm.configured) && "opacity-60")}>
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--brand)]"
              checked={v.llmEnabled}
              disabled={llm.demo}
              onChange={(e) => set("llmEnabled", e.target.checked)}
              aria-describedby="llm-note"
            />
            <span>
              <span className="text-sm font-medium">外部の AI{llm.model && `（${llm.model}）`}で項目を取り出す</span>
              <span id="llm-note" className="mt-1 block text-xs text-muted-foreground">
                {llm.demo
                  ? "デモ環境では使えません（デモは事前に処理した結果と、サーバー内の OCR・規則による抽出で動きます）。"
                  : !llm.configured
                    ? "サーバーに ANTHROPIC_API_KEY と LLM_MODEL が設定されていません。有効にしても、規則による抽出を使います。"
                    : "実際の取引先の書類を送ってよいか、社内の取り扱いを確認してから有効にしてください。AI が失敗したときは規則による抽出に切り替えます。"}
              </span>
            </span>
          </label>
        </div>
      </Panel>

      <div className="mt-4 flex justify-end gap-2">
        {dirty && <Button type="button" variant="ghost" onClick={() => { setV(initial); setErrors({}); }}>元に戻す</Button>}
        <Button type="submit" variant="brand" disabled={!dirty || busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          設定を保存
        </Button>
      </div>
    </form>
  );
}
