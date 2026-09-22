import type { Metadata } from 'next';
import { requestObservePage } from '../../catalog';
import { ObserveView } from '../../components/observe/observe';
import { pageTitle, requestStudioLang } from '../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return pageTitle('conversations', await requestStudioLang());
}
export default async function Page() {
  const lang = await requestStudioLang();
  return <ObserveView page={requestObservePage()} lang={lang}/>;
}
