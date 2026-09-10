import { requestCatalog } from '../../catalog';
import { RunList, SourceError } from '../../components/measure';
import { StudioShell } from '../../components/shell';
export const dynamic = 'force-dynamic';
export default async function MeasurePage({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = (await searchParams).lang === 'en' ? 'en' : 'zh';
  let runs;
  try { runs = await requestCatalog().list(); } catch { return <StudioShell lang={lang}><SourceError lang={lang}/></StudioShell>; }
  return <StudioShell lang={lang}><RunList runs={runs} lang={lang}/></StudioShell>;
}
