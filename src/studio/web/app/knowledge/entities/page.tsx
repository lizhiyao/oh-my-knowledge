import type { Metadata } from 'next';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../components/layout/page-titles';
import { KnowledgeEntities } from '../../../components/knowledge/entities';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return pageTitle('entities', await requestStudioLang());
}
export default async function Page({ searchParams }: { searchParams: Promise<{ workspace?: string; analysis?: string; entity?: string; revision?: string; thread?: string }> }) {
  const params = await searchParams; const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="knowledge"><KnowledgeEntities lang={lang} initialWorkspace={params.workspace}
    initialAnalysisId={params.analysis} initialEntityId={params.entity} initialRevision={params.revision} threadId={params.thread}/></StudioShell>;
}
