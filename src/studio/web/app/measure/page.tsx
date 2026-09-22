import type { Metadata } from 'next';
import { requestMeasureRuns } from '../../catalog';
import { RunList, RunSidebar } from '../../components/measure/measure';
import { StudioShell } from '../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return pageTitle('measure', await requestStudioLang());
}
export default async function MeasureIndexPage() {
  const lang = await requestStudioLang();
  const runs = requestMeasureRuns();
  return <StudioShell lang={lang} active="measure" sidebar={<RunSidebar runs={runs} lang={lang}/>}><RunList runs={runs} lang={lang}/></StudioShell>;
}
