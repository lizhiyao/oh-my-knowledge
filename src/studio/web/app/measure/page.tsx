import type { Metadata } from 'next';
import { requestMeasureRuns } from '../../catalog';
import { RunList } from '../../components/measure/measure';
import { StudioShell } from '../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return pageTitle('measure', await requestStudioLang());
}
export default async function MeasureIndexPage() {
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="measure"><RunList runs={requestMeasureRuns()} lang={lang}/></StudioShell>;
}
