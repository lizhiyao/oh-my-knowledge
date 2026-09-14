import type { Metadata } from 'next';
import { requestCatalog } from '../../catalog';
import { RunList } from '../../components/measure/measure';
import { StudioShell } from '../../components/layout/shell';
import { pageTitle, studioLang } from '../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ searchParams }: { searchParams: Promise<{lang?: string}> }): Promise<Metadata> {
  return pageTitle('measure', studioLang(await searchParams));
}
export default async function MeasurePage({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = studioLang(await searchParams);
  // 宿主在流式输出前预解析并替换 catalog.list；失败态已由宿主给出状态码。
  const runs = await requestCatalog().list();
  return <StudioShell lang={lang} active="measure"><RunList runs={runs} lang={lang}/></StudioShell>;
}
