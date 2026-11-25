"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** 検索（ファイル名・発行元・書類番号）・書類種別・発行日の期間 */
export function DocumentFilters({ q, type, from, to }: { q: string; type: string; from: string; to: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [text, setText] = useState(q);
  const apply = (over: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    p.delete("page");
    for (const [k, v] of Object.entries(over)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    router.push(`/documents${p.size ? `?${p.toString()}` : ""}`);
  };
  const hasFilter = !!(q || type || from || to);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form
        className="relative w-full sm:w-72"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ q: text.trim() });
        }}
        role="search"
      >
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="ファイル名・発行元・番号" className="pl-8" aria-label="検索" maxLength={100} />
      </form>
      <Select value={type || "all"} onValueChange={(v) => apply({ type: v === "all" ? "" : v })}>
        <SelectTrigger className="w-36" aria-label="書類種別"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">すべての種別</SelectItem>
          <SelectItem value="invoice">請求書</SelectItem>
          <SelectItem value="receipt">領収書</SelectItem>
          <SelectItem value="delivery_note">納品書</SelectItem>
          <SelectItem value="unknown">不明</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Input type="date" value={from} onChange={(e) => apply({ from: e.target.value })} className="w-36" aria-label="発行日（から）" />
        〜
        <Input type="date" value={to} onChange={(e) => apply({ to: e.target.value })} className="w-36" aria-label="発行日（まで）" />
      </div>
      {hasFilter && (
        <Button variant="ghost" size="sm" onClick={() => { setText(""); apply({ q: "", type: "", from: "", to: "" }); }}>
          <X aria-hidden />条件をクリア
        </Button>
      )}
    </div>
  );
}
