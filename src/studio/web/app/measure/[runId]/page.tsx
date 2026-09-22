import type { Metadata } from 'next';
import { requestMeasureRun, requestMeasureRuns } from '../../../catalog';
import { RunDetail, RunSidebar } from '../../../components/measure/measure';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{runId: string}> }): Promise<Metadata> {
  const { runId } = await params;
  return pageTitle('measureRun', await requestStudioLang(), runId);
}
export default async function MeasureRunPage({ params }: { params: Promise<{runId: string}> }) {
  const lang = await requestStudioLang();
  const { runId } = await params;
  return <StudioShell lang={lang} active="measure" sidebar={<RunSidebar runs={requestMeasureRuns()} activeRunId={runId} lang={lang}/>}><RunDetail detail={requestMeasureRun()} lang={lang}/></StudioShell>;
}
