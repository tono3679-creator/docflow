import Image from "next/image";
import Link from "next/link";
import { Logo } from "@/components/layout/logo";
import { DemoButton } from "@/components/public/demo-buttons";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: { absolute: "DocFlow — 請求書・領収書・納品書の読み取りと確認" },
  description: "PDF・スキャン画像の請求書・領収書・納品書から項目を読み取り、確認が必要な箇所だけを原本の上に示す。中小企業向けの帳票処理システム（デモ）。",
};

const PROBLEMS = [
  { before: "届いた請求書を、会計ソフトや Excel に1件ずつ手で入力している", after: "PDF・スキャン画像をまとめてアップロード。発行元・番号・日付・金額・明細を読み取り、入力欄に入れておく" },
  { before: "AI や OCR の結果を、結局すべて原本と見比べている", after: "読み取りに自信がない項目だけを黄色、計算が合わない項目を赤で、原本の位置に印を付けて示す" },
  { before: "金額の検算（数量×単価・小計・消費税）に時間がかかる", after: "明細の合計・税率ごとの消費税・合計を自動で照合。計算方式が分からないときは「検証不能」と正直に示す" },
  { before: "同じ請求書を二重に計上しそうになる", after: "同じファイル・同じ番号・日付と金額が同じ書類を重複の候補として表示。消さずに人が判断する" },
];

const COMPARE = [
  ["入力", "原本を見ながら手入力", "読み取った値を確認し、違うところだけ直す"],
  ["確認", "全項目を原本と見比べる", "黄（要確認）・赤（不整合）の項目だけ見る。押すと原本の位置へ移動"],
  ["検算", "電卓で数量×単価・消費税を計算", "自動で照合し、合わない箇所を表示"],
  ["重複", "過去の書類を探して目で確認", "候補を表示。「重複として除外」か「重複ではない」を選ぶ"],
  ["記録", "誰がいつ直したか分からない", "修正前後の値・確定した人と日時を履歴に残す"],
] as const;

/** 月300件（1件あたり約5分）の会社を想定した試算 */
const ESTIMATE = [
  ["書類の仕分け・ファイル名の整理", 3, 0.5],
  ["項目の入力（会計ソフト・Excel への転記）", 15, 4],
  ["金額の検算", 4, 1.5],
  ["重複・漏れの確認", 3, 2],
] as const;

const FLOW = [
  ["アップロード", "PDF・PNG・JPEG・WebP をまとめて。スマートフォンで撮った写真も"],
  ["自動で読み取り", "PDF の文字情報、画像は OCR。種別（請求書・領収書・納品書）も判定"],
  ["要確認だけ見る", "一覧の「要確認」から開く。黄・赤の印が付いた項目だけ確認"],
  ["原本と見比べて直す", "項目を押すと原本の位置へ。直した値で照合し直す"],
  ["確定する", "確認事項が残っている書類は確定できない"],
  ["Excel・CSV に出力", "書類種別ごとの列と明細のシート。会計ソフトへの取り込みに"],
] as const;

const FEATURES = [
  ["読み取り", "PDF の文字と位置／画像は OCR（サーバー内）。読めない項目は推測で埋めず空欄"],
  ["原本と項目の連動", "項目を押すと原本の位置へ、原本の印を押すと項目へ。拡大・回転・複数ページ"],
  ["金額の照合", "数量×単価・明細の合計・税率ごとの消費税・合計。一致／不一致／検証不能"],
  ["重複の検出", "同じファイル・同じ番号・日付と金額。自動では消さない"],
  ["確定と履歴", "確定時の値を保存。修正前後・承認の理由・確定者を記録"],
  ["出力", "Excel（種別ごとのシート＋明細）と CSV。数式として動く文字は無害化"],
  ["権限", "管理者・担当者・閲覧者。画面・サーバー・DB の3段階で制御"],
  ["会社ごとの分離", "すべてのデータを会社単位で分離（行レベルセキュリティ）。ファイルは非公開"],
] as const;

export default function Home() {
  const before = ESTIMATE.reduce((s, r) => s + r[1], 0);
  const after = ESTIMATE.reduce((s, r) => s + r[2], 0);
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild><Link href="/login">ログイン</Link></Button>
            <DemoButton size="lg" className="hidden h-9 sm:inline-flex" />
          </nav>
        </div>
      </header>

      <main>
        {/* ヒーロー */}
        <section className="mx-auto max-w-6xl px-4 pt-14 pb-12 sm:px-6 sm:pt-20">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-brand">中小企業向け 請求書・領収書・納品書の処理</p>
            <h1 className="text-keep mt-3 text-3xl leading-tight font-bold tracking-tight sm:text-5xl sm:leading-tight">
              確認するのは、<br />自信のない項目だけ。
            </h1>
            <p className="text-keep mt-5 text-base leading-relaxed text-muted-foreground sm:text-lg">
              PDF やスキャン画像から項目を読み取り、確認が必要な箇所を原本の上に示します。人が見て確定した値だけを、Excel・CSV に出力します。
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <DemoButton size="xl" />
              <span className="text-sm text-muted-foreground">登録不要・あなた専用の架空データで約3〜5分</span>
            </div>
          </div>
          <div className="mt-12 overflow-hidden rounded-xl border bg-card">
            <Image src="/screens/review.png" alt="確認画面。左に原本、右に項目。確認が必要な項目に黄色、計算が合わない項目に赤の印が付いている" width={1440} height={900} priority className="h-auto w-full" />
          </div>
        </section>

        {/* 課題と解決 */}
        <Section title="よくある困りごとを、仕組みで解決">
          <div className="grid gap-3 md:grid-cols-2">
            {PROBLEMS.map((p) => (
              <div key={p.before} className="rounded-lg border bg-card p-5">
                <p className="text-keep text-sm text-muted-foreground">{p.before}</p>
                <p className="text-keep mt-2 font-medium leading-relaxed">{p.after}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* Before / After */}
        <Section title="導入前と導入後">
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="hidden bg-muted/50 text-xs text-muted-foreground sm:table-header-group">
                <tr><th className="w-28 px-5 py-2.5 text-left font-medium">作業</th><th className="px-5 py-2.5 text-left font-medium">Before</th><th className="px-5 py-2.5 text-left font-medium">After</th></tr>
              </thead>
              <tbody className="divide-y">
                {COMPARE.map(([task, b, a]) => (
                  <tr key={task} className="grid gap-1 px-5 py-4 sm:table-row sm:p-0">
                    <th scope="row" className="text-left font-semibold sm:px-5 sm:py-3.5">{task}</th>
                    <td className="text-muted-foreground sm:px-5 sm:py-3.5"><span className="mr-2 text-xs sm:hidden">Before</span>{b}</td>
                    <td className="sm:px-5 sm:py-3.5"><span className="mr-2 text-xs text-brand sm:hidden">After</span>{a}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* 効果の試算 */}
        <Section title="効果の試算（月300件の場合）">
          <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
            <div className="grid grid-cols-3 gap-3 self-start rounded-lg border bg-card p-5">
              <Metric label="導入前" value={`${before}`} unit="時間/月" muted />
              <Metric label="導入後" value={`${after}`} unit="時間/月" />
              <Metric label="削減" value={`${before - after}`} unit="時間/月" accent />
              <div className="col-span-3 border-t pt-4">
                <p className="text-sm text-muted-foreground">年間</p>
                <p className="tabular text-3xl font-bold">{(before - after) * 12}<span className="ml-1 text-base font-medium">時間の削減</span></p>
              </div>
            </div>
            <div className="rounded-lg border bg-card">
              <table className="w-full text-sm">
                <caption className="sr-only">作業ごとの試算（月あたり）</caption>
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b"><th className="px-5 py-2.5 text-left font-medium">作業（月あたり）</th><th className="px-3 py-2.5 text-right font-medium">導入前</th><th className="px-5 py-2.5 text-right font-medium">導入後</th></tr>
                </thead>
                <tbody className="divide-y">
                  {ESTIMATE.map(([task, b, a]) => (
                    <tr key={task}><td className="px-5 py-3">{task}</td><td className="tabular whitespace-nowrap px-3 py-3 text-right text-muted-foreground">{b}時間</td><td className="tabular whitespace-nowrap px-5 py-3 text-right font-medium">{a}時間</td></tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t font-semibold"><td className="px-5 py-3">合計</td><td className="tabular whitespace-nowrap px-3 py-3 text-right">{before}時間</td><td className="tabular whitespace-nowrap px-5 py-3 text-right">{after}時間</td></tr>
                </tfoot>
              </table>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            ※ 架空企業のシミュレーションです。月300件（1件あたり約5分の手作業）の会社が、要確認の項目の確認と修正だけを行う想定で試算しました。実際の導入実績や効果を保証するものではありません。
          </p>
        </Section>

        {/* 精度 */}
        <Section title="読み取りの精度（実測）">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat value="220 / 220" label="PDF の見出しの項目" sub="発行元・番号・日付・金額など" />
            <Stat value="19 / 20" label="読み間違いを「要確認」で検出" sub="画像の読み取りの誤りを含む" />
            <Stat value="0 件" label="書かれていない値を埋めた件数" sub="読めない項目は空欄のまま" />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            ※ 架空のデモ書類 37 件での測定（全項目の正解率 88.4%。低解像度の画像や写真は下がります）。読み取りは間違えることがあるため、人が確認して確定する前提で作っています。
          </p>
        </Section>

        {/* デモの流れ */}
        <Section title="3〜5分で体験できる流れ">
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FLOW.map(([t, d], i) => (
              <li key={t} className="flex gap-3 rounded-lg border bg-card p-4">
                <span className="tabular grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-sm font-semibold text-background">{i + 1}</span>
                <div><p className="font-semibold">{t}</p><p className="text-keep mt-0.5 text-sm text-muted-foreground">{d}</p></div>
              </li>
            ))}
          </ol>
          <div className="mt-6 grid items-center gap-6 rounded-lg border bg-card p-5 sm:grid-cols-[1fr_auto] sm:p-6">
            <div>
              <p className="font-semibold">スマートフォンでも確認できます</p>
              <p className="text-keep mt-1 text-sm text-muted-foreground">「原本」と「項目」をタブで切り替え。項目の横の印を押すと、原本のその位置を表示します。</p>
            </div>
            <Image src="/screens/mobile-review.png" alt="スマートフォンの確認画面" width={390} height={844} className="mx-auto h-auto w-40 rounded-xl border sm:w-44" />
          </div>
        </Section>

        {/* 機能 */}
        <Section title="主な機能">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map(([t, d]) => (
              <div key={t}><dt className="font-semibold">{t}</dt><dd className="text-keep mt-1 text-sm text-muted-foreground">{d}</dd></div>
            ))}
          </dl>
        </Section>

        {/* 取り扱い */}
        <Section title="書類の取り扱い">
          <ul className="grid gap-2 rounded-lg border bg-card p-5 text-sm leading-relaxed">
            <li>ファイルは非公開で保存し、同じ会社のメンバーだけが見られます。</li>
            <li>画像の文字の読み取り（OCR）は、このシステムのサーバーの中で行います。</li>
            <li>外部の AI に送るかは、会社の管理者が設定で決めます（既定は送らない）。デモでは送りません。</li>
            <li>デモの表示結果には「事前処理の結果」と表示しています。アップロードした書類は、その場で読み取ります。</li>
          </ul>
        </Section>

        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="flex flex-col items-start gap-4 rounded-xl border bg-card p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
            <div>
              <p className="text-lg font-bold">実際に操作してみてください</p>
              <p className="mt-1 text-sm text-muted-foreground">架空の会社「株式会社山田商事」の書類 37 件（請求書・領収書・納品書）で試せます。</p>
            </div>
            <DemoButton size="xl" />
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-6">
          <span>DocFlow（ポートフォリオ作品）</span>
          <span>掲載している会社名・書類・数値はすべて架空です。</span>
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h2 className="mb-6 text-xl font-bold tracking-tight sm:text-2xl">{title}</h2>
      {children}
    </section>
  );
}

function Metric({ label, value, unit, muted, accent }: { label: string; value: string; unit: string; muted?: boolean; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`tabular mt-1 text-3xl font-bold ${muted ? "text-muted-foreground" : accent ? "text-brand" : ""}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{unit}</p>
    </div>
  );
}

function Stat({ value, label, sub }: { value: string; label: string; sub: string }) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <p className="tabular text-2xl font-bold">{value}</p>
      <p className="mt-1 text-sm font-medium">{label}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}
