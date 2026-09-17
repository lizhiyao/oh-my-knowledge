import type { Metadata } from 'next';
import { requestMeasureRun } from '../../../catalog';
import { RunDetail } from '../../../components/measure/measure';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{runId: string}> }): Promise<Metadata> {
  const { runId } = await params;
  return pageTitle('measureRun', await requestStudioLang(), runId);
}
export default async function MeasureRunPage() {
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="measure"><RunDetail detail={requestMeasureRun()} lang={lang}/></StudioShell>;
}
