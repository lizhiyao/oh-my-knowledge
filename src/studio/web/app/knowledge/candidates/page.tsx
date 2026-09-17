import type { Metadata } from 'next';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../components/layout/page-titles';
import { KnowledgeCandidates } from '../../../components/knowledge/candidates';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return pageTitle('candidates', await requestStudioLang());
}
export default async function Page({ searchParams }: { searchParams: Promise<{ workspace?: string; id?: string }> }) {
  const params = await searchParams;
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="knowledge"><KnowledgeCandidates lang={lang} initialWorkspace={params.workspace ?? ''} initialId={params.id}/></StudioShell>;
}
