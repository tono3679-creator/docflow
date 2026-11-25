import { notFound } from "next/navigation";
import { ReviewScreen } from "@/components/review/review-screen";
import { asCurrentUser, requireUser } from "@/lib/auth";
import { documentHistory, getDocumentDetail, neighbors } from "@/lib/data/documents";
import { computeValidation } from "@/lib/documents/validation";

export const metadata = { title: "書類の確認" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const user = await requireUser();
  const data = await asCurrentUser(async (tx) => {
    const detail = await getDocumentDetail(tx, id);
    if (!detail) return null;
    const nav = await neighbors(tx, id);
    const history = await documentHistory(tx, id);
    // 金額の照合は、保存されている今の値から計算し直して表示する（保存はしない）
    const validation = detail.doc.document_type ? await computeValidation(tx, user.organizationId, id) : null;
    return { detail, nav, history, checks: validation?.result.checks ?? [] };
  });
  if (!data) notFound();
  return (
    <ReviewScreen
      key={`${data.detail.doc.id}`}
      detail={data.detail}
      nav={data.nav}
      history={data.history}
      checks={data.checks}
      role={user.role}
      staffConfirmLimit={user.settings.staffConfirmLimit}
    />
  );
}
