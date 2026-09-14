import type { Metadata } from 'next';
import { requestKnowledgePage } from '../../catalog';
import { KnowledgeView } from '../../components/knowledge/knowledge';
import { StudioShell } from '../../components/layout/shell';
import { pageTitle, studioLang } from '../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ searchParams }: { searchParams: Promise<{lang?: string}> }): Promise<Metadata> {
  return pageTitle('knowledge', studioLang(await searchParams));
}
export default async function Page({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = studioLang(await searchParams);
  return <StudioShell lang={lang} active="knowledge"><KnowledgeView page={requestKnowledgePage()} lang={lang}/></StudioShell>;
}
