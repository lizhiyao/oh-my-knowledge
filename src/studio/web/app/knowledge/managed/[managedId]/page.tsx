import { requestManagedPage } from '../../../../catalog';
import { ManagedView } from '../../../../components/knowledge/managed';
import { StudioShell } from '../../../../components/layout/shell';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = (await searchParams).lang === 'en' ? 'en' : 'zh';
  return <StudioShell lang={lang} active="knowledge"><ManagedView page={requestManagedPage()} lang={lang}/></StudioShell>;
}
