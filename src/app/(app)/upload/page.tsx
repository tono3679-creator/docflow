import { Page } from "@/components/common/page";
import { PageHeader } from "@/components/common/page-header";
import { UploadPanel } from "@/components/documents/upload-panel";
import { requireRole } from "@/lib/auth";
import { maxFileBytes } from "@/lib/documents/upload";
import { aiEnv } from "@/lib/env";

export const metadata = { title: "アップロード" };

export default async function UploadPage() {
  const user = await requireRole(["admin", "staff"]);
  const llmActive = user.settings.llmEnabled && !user.isDemo && aiEnv().llmProvider !== "none";
  return (
    <Page>
      <PageHeader title="アップロード" />
      <UploadPanel
        maxBytes={maxFileBytes(user)}
        maxPages={user.settings.maxPages}
        isDemo={user.isDemo}
        llmActive={llmActive}
      />
    </Page>
  );
}
