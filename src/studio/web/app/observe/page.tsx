import { requestObservePage } from '../../catalog';
import { ObserveView } from '../../components/observe';
import { StudioShell } from '../../components/shell';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = (await searchParams).lang === 'en' ? 'en' : 'zh';
  return <StudioShell lang={lang} active="observe"><ObserveView page={requestObservePage()} lang={lang}/></StudioShell>;
}
