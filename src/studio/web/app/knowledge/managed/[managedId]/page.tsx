import type { Metadata } from 'next';
import { requestManagedPage } from '../../../../catalog';
import { ManagedView } from '../../../../components/knowledge/managed';
import { StudioShell } from '../../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{managedId: string}> }): Promise<Metadata> {
  const { managedId } = await params;
  return pageTitle('managed', await requestStudioLang(), managedId);
}
export default async function Page() {
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="knowledge"><ManagedView page={requestManagedPage()} lang={lang}/></StudioShell>;
}
