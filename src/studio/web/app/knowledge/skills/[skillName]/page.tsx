import { requestKnowledgePage } from '../../../../catalog';
import { KnowledgeView } from '../../../../components/knowledge/knowledge';
import { StudioShell } from '../../../../components/layout/shell';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{lang?: string}> }) {
  const lang = (await searchParams).lang === 'en' ? 'en' : 'zh';
  return <StudioShell lang={lang} active="knowledge"><KnowledgeView page={requestKnowledgePage()} lang={lang}/></StudioShell>;
}
