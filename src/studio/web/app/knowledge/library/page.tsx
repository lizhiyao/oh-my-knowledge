import type { Metadata } from 'next';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../components/layout/page-titles';
import { KnowledgeLibrary } from '../../../components/knowledge/library';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> { return pageTitle('library', await requestStudioLang()); }
export default async function Page({ searchParams }: { searchParams: Promise<{ workspace?: string; knowledge?: string; object?: string; revision?: string; analysis?: string; entity?: string; entityRevision?: string }> }) {
  const params = await searchParams; const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="knowledge"><KnowledgeLibrary lang={lang} initialWorkspace={params.workspace}
    knowledgeId={params.knowledge} objectId={params.object} revisionId={params.revision} seed={params.analysis && params.entity ? {
      analysisId: params.analysis, entityId: params.entity, revision: params.entityRevision } : undefined}/></StudioShell>;
}
