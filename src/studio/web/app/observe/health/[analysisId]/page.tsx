import type { Metadata } from 'next';
import { requestHealthPage } from '../../../../catalog';
import { HealthView } from '../../../../components/observe/health';
import { StudioShell } from '../../../../components/layout/shell';
import { pageTitle, studioLang } from '../../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params, searchParams }: { params: Promise<{analysisId: string}>; searchParams: Promise<{lang?: string}> }): Promise<Metadata> {
  const { analysisId } = await params;
  return pageTitle('health', studioLang(await searchParams), analysisId);
}
export default async function Page({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = studioLang(await searchParams);
  return <StudioShell lang={lang} active="observe"><HealthView page={requestHealthPage()} lang={lang}/></StudioShell>;
}
