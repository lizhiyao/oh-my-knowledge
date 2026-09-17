import type { Metadata } from 'next';
import { requestHealthPage } from '../../../catalog';
import { HealthView } from '../../../components/observe/health';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../components/layout/page-titles';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return pageTitle('healthDiff', await requestStudioLang());
}
export default async function Page() {
  const lang = await requestStudioLang();
  return <StudioShell lang={lang} active="knowledge"><HealthView page={requestHealthPage()} lang={lang}/></StudioShell>;
}
