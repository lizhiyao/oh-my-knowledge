import { requestHealthPage } from '../../../catalog';
import { HealthView } from '../../../components/observe/health';
import { StudioShell } from '../../../components/layout/shell';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = (await searchParams).lang === 'en' ? 'en' : 'zh';
  return <StudioShell lang={lang} active="observe"><HealthView page={requestHealthPage()} lang={lang}/></StudioShell>;
}
