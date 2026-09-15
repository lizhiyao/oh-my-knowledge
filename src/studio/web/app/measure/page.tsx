import type { Metadata } from 'next';
import { requestMeasureRuns } from '../../catalog';
import { RunList } from '../../components/measure/measure';
import { StudioShell } from '../../components/layout/shell';
import { pageTitle, studioLang } from '../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ searchParams }: { searchParams: Promise<{lang?: string}> }): Promise<Metadata> {
  return pageTitle('measure', studioLang(await searchParams));
}
export default async function MeasureIndexPage({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = studioLang(await searchParams);
  return <StudioShell lang={lang} active="measure"><RunList runs={requestMeasureRuns()} lang={lang}/></StudioShell>;
}
