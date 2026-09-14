import type { Metadata } from 'next';
import { requestObservePage } from '../../../../catalog';
import { ObserveView } from '../../../../components/observe/observe';
import { StudioShell } from '../../../../components/layout/shell';
import { pageTitle, studioLang } from '../../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params, searchParams }: { params: Promise<{threadId: string}>; searchParams: Promise<{lang?: string}> }): Promise<Metadata> {
  const { threadId } = await params;
  return pageTitle('conversation', studioLang(await searchParams), threadId);
}
export default async function Page({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = studioLang(await searchParams);
  return <StudioShell lang={lang} active="observe" utilitiesInSidebar><ObserveView page={requestObservePage()} lang={lang}/></StudioShell>;
}
