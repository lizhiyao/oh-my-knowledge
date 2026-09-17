import type { Metadata } from 'next';
import { requestObservePage } from '../../../../catalog';
import { ObserveView } from '../../../../components/observe/observe';
import { StudioShell } from '../../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{threadId: string}> }): Promise<Metadata> {
  const { threadId } = await params;
  return pageTitle('conversation', await requestStudioLang(), threadId);
}
export default async function Page() {
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="observe" utilitiesInSidebar><ObserveView page={requestObservePage()} lang={lang}/></StudioShell>;
}
