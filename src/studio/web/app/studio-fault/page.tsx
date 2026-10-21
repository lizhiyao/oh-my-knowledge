import type { Metadata } from 'next';
import { requestPageFault } from '../../catalog';
import { PageFaultView } from '../../components/layout/page-fault';
import { requestStudioLang } from '../../components/layout/page-titles';
import { StudioShell } from '../../components/layout/shell';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return { title: await requestStudioLang() === 'zh' ? '页面暂不可用' : 'Page unavailable' };
}
/** Private rendering destination. Only the host's fault rewrite can reach it. */
export default async function Page() {
  const page = requestPageFault();
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active={page.section}><PageFaultView page={page} lang={lang}/></StudioShell>;
}
