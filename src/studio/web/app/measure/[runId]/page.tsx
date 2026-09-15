import type { Metadata } from 'next';
import { requestMeasureRun } from '../../../catalog';
import { RunDetail } from '../../../components/measure/measure';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, studioLang } from '../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params, searchParams }: { params: Promise<{runId: string}>; searchParams: Promise<{lang?: string}> }): Promise<Metadata> {
  const { runId } = await params;
  return pageTitle('measureRun', studioLang(await searchParams), runId);
}
export default async function MeasureRunPage({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = studioLang(await searchParams);
  return <StudioShell lang={lang} active="measure"><RunDetail detail={requestMeasureRun()} lang={lang}/></StudioShell>;
}
