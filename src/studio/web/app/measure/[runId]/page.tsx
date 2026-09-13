import { requestCatalog } from '../../../catalog';
import { RunDetail } from '../../../components/measure/measure';
import { StudioShell } from '../../../components/layout/shell';
import { notFound } from 'next/navigation';
export const dynamic = 'force-dynamic';
export default async function DetailPage({ params, searchParams }: { params: Promise<{runId: string}>; searchParams: Promise<{lang?: string}> }) {
  const { runId } = await params;
  const lang = (await searchParams).lang === 'en' ? 'en' : 'zh';
  // 宿主在流式输出前预解析并替换 catalog.get；缺失的运行记录已由宿主给出 404。
  const detail = await requestCatalog().get(runId);
  if (!detail) notFound();
  return <StudioShell lang={lang} active="measure"><RunDetail detail={detail} lang={lang}/></StudioShell>;
}
