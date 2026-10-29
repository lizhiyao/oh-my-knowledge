import type { Metadata } from 'next';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../components/layout/page-titles';
import { KnowledgeCandidates } from '../../../components/knowledge/candidates';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return pageTitle('candidates', await requestStudioLang());
}
export default async function Page({ searchParams }: { searchParams: Promise<{ workspace?: string; id?: string; revision?: string; segment?: string; edit?: string; reason?: string }> }) {
  const params = await searchParams;
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="knowledge"><KnowledgeCandidates key={params.workspace ?? ''} lang={lang} initialWorkspace={params.workspace ?? ''} initialId={params.id} initialRevision={params.revision} initialSegmentId={params.segment} initialEdit={params.edit === 'true'} initialReason={params.reason?.slice(0, 4096)}/></StudioShell>;
}
