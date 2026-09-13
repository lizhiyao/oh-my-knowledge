import { requestCatalog } from '../../catalog';
import { RunList } from '../../components/measure/measure';
import { StudioShell } from '../../components/layout/shell';
export const dynamic = 'force-dynamic';
export default async function MeasurePage({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = (await searchParams).lang === 'en' ? 'en' : 'zh';
  // 宿主在流式输出前预解析并替换 catalog.list；失败态已由宿主给出状态码。
  const runs = await requestCatalog().list();
  return <StudioShell lang={lang} active="measure"><RunList runs={runs} lang={lang}/></StudioShell>;
}
