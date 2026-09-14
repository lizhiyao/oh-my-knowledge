import type { Metadata } from 'next';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, studioLang } from '../../../components/layout/page-titles';
import { KnowledgeCandidates } from '../../../components/knowledge/candidates';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ lang?: string }> }): Promise<Metadata> {
  return pageTitle('candidates', studioLang(await searchParams));
}
export default async function Page({ searchParams }: { searchParams: Promise<{ lang?: string; workspace?: string; id?: string }> }) {
  const params = await searchParams;
  const lang = studioLang(params);
  return <StudioShell lang={lang} active="knowledge"><KnowledgeCandidates lang={lang} initialWorkspace={params.workspace ?? ''} initialId={params.id}/></StudioShell>;
}
