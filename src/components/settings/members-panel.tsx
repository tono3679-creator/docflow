"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, UserPlus } from "lucide-react";
import { Panel } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addMember, updateMember } from "@/lib/actions/settings";
import { safeAction } from "@/lib/client/safe-action";
import type { MemberRow } from "@/lib/data/settings";
import { ROLE_LABEL, ROLES, type OrgRole } from "@/lib/domain/labels";

const ROLE_HELP: Record<OrgRole, string> = {
  admin: "すべての操作・設定・メンバー・削除",
  staff: "アップロード・確認・確定・出力",
  viewer: "閲覧のみ",
};

function AddMemberDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [v, setV] = useState({ email: "", displayName: "", role: "staff" as OrgRole, password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const res = await safeAction(() => addMember(v));
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    toast.success("メンバーを追加しました。メールアドレスと初期パスワードを本人に伝えてください");
    setV({ email: "", displayName: "", role: "staff", password: "" });
    setErrors({});
    onOpenChange(false);
    router.refresh();
  };
  const field = (id: keyof typeof v, label: string, props: React.ComponentProps<typeof Input>) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`m-${id}`}>{label}</Label>
      <Input id={`m-${id}`} value={v[id]} onChange={(e) => setV((c) => ({ ...c, [id]: e.target.value }))} aria-invalid={!!errors[id]} {...props} />
      {errors[id] && <p className="text-xs text-destructive">{errors[id]}</p>}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>メンバーを追加</DialogTitle>
          <DialogDescription>メールアドレスと初期パスワードでログインできるようになります。</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          {field("displayName", "名前", { autoComplete: "off" })}
          {field("email", "メールアドレス", { type: "email", autoComplete: "off" })}
          {field("password", "初期パスワード（10文字以上）", { type: "password", autoComplete: "new-password" })}
          <div className="grid gap-1.5">
            <Label>役割</Label>
            <Select value={v.role} onValueChange={(r) => setV((c) => ({ ...c, role: r as OrgRole }))}>
              <SelectTrigger aria-label="役割"><SelectValue /></SelectTrigger>
              <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABEL[r]}（{ROLE_HELP[r]}）</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>やめる</Button>
            <Button type="submit" variant="brand" disabled={busy}>{busy && <Loader2 className="animate-spin" aria-hidden />}追加</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MembersPanel({ members, currentUserId, isDemo }: { members: MemberRow[]; currentUserId: string; isDemo: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const change = async (m: MemberRow, patch: Partial<{ role: OrgRole; active: boolean }>) => {
    setBusy(m.user_id);
    const res = await safeAction(() => updateMember({ userId: m.user_id, role: patch.role ?? m.role, active: patch.active ?? m.is_active }));
    setBusy(null);
    if (!res.ok) toast.error(res.error);
    else {
      toast.success("変更しました");
      router.refresh();
    }
  };
  return (
    <Panel>
      <ul className="divide-y">
        {members.map((m) => {
          const self = m.user_id === currentUserId;
          return (
            <li key={m.user_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {m.display_name}
                  {self && <Badge variant="neutral">自分</Badge>}
                  {!m.is_active && <Badge variant="neutral">停止中</Badge>}
                </div>
                <div className="truncate text-xs text-muted-foreground">{m.is_anonymous ? "デモの利用者" : m.email}</div>
              </div>
              <Select value={m.role} disabled={self || isDemo || busy === m.user_id} onValueChange={(r) => void change(m, { role: r as OrgRole })}>
                <SelectTrigger className="h-8 w-28 text-xs" aria-label={`${m.display_name}の役割`}><SelectValue /></SelectTrigger>
                <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>)}</SelectContent>
              </Select>
              <Button variant="ghost" size="sm" className="w-20 text-xs" disabled={self || isDemo || busy === m.user_id} onClick={() => void change(m, { active: !m.is_active })}>
                {busy === m.user_id ? <Loader2 className="animate-spin" aria-hidden /> : m.is_active ? "利用停止" : "再開"}
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
        <p className="text-xs text-muted-foreground">{isDemo ? "デモ環境ではメンバーの追加・変更はできません。役割は上の「デモ」の帯から切り替えられます。" : "役割：管理者＝すべて／担当者＝確認・確定・出力／閲覧者＝閲覧のみ"}</p>
        <Button variant="outline" size="sm" disabled={isDemo} onClick={() => setAdding(true)}><UserPlus aria-hidden />メンバーを追加</Button>
      </div>
      <AddMemberDialog open={adding} onOpenChange={setAdding} />
    </Panel>
  );
}
