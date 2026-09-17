import type { Metadata } from 'next';
import { requestKnowledgePage } from '../../../../catalog';
import { KnowledgeView } from '../../../../components/knowledge/knowledge';
import { StudioShell } from '../../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{skillName: string}> }): Promise<Metadata> {
  const { skillName } = await params;
  return pageTitle('knowledge', await requestStudioLang(), skillName);
}
export default async function Page() {
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="knowledge"><KnowledgeView page={requestKnowledgePage()} lang={lang}/></StudioShell>;
}
