import { requestCatalog } from '../../../catalog';
import { RunDetail, SourceError } from '../../../components/measure';
import { StudioShell } from '../../../components/shell';
import { notFound } from 'next/navigation';
export const dynamic = 'force-dynamic';
export default async function DetailPage({ params, searchParams }: { params: Promise<{runId: string}>; searchParams: Promise<{lang?: string}> }) {
  const { runId } = await params;
  const lang = (await searchParams).lang === 'en' ? 'en' : 'zh';
  let detail;
  try { detail = await requestCatalog().get(runId); } catch { return <StudioShell lang={lang}><SourceError lang={lang}/></StudioShell>; }
  if (!detail) notFound();
  return <StudioShell lang={lang}><RunDetail detail={detail} lang={lang}/></StudioShell>;
}
