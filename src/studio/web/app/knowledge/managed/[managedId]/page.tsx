import type { Metadata } from 'next';
import { requestManagedPage } from '../../../../catalog';
import { ManagedView } from '../../../../components/knowledge/managed';
import { StudioShell } from '../../../../components/layout/shell';
import { pageTitle, studioLang } from '../../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params, searchParams }: { params: Promise<{managedId: string}>; searchParams: Promise<{lang?: string}> }): Promise<Metadata> {
  const { managedId } = await params;
  return pageTitle('managed', studioLang(await searchParams), managedId);
}
export default async function Page({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = studioLang(await searchParams);
  return <StudioShell lang={lang} active="knowledge"><ManagedView page={requestManagedPage()} lang={lang}/></StudioShell>;
}
