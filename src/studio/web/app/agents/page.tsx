import type { Metadata } from 'next';
import { requestAgentsPage } from '../../catalog';
import { AgentsView } from '../../components/agents/agents';
import { StudioShell } from '../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return pageTitle('agents', await requestStudioLang());
}
export default async function Page() {
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="agents"><AgentsView page={requestAgentsPage()} lang={lang}/></StudioShell>;
}
