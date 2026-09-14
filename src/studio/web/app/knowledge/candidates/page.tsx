import { StudioShell } from '../../../components/layout/shell';
import { KnowledgeCandidates } from '../../../components/knowledge/candidates';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ lang?: string; workspace?: string; id?: string }> }) {
  const params = await searchParams;
  const lang = params.lang === 'en' ? 'en' : 'zh';
  return <StudioShell lang={lang} active="knowledge"><KnowledgeCandidates lang={lang} initialWorkspace={params.workspace ?? ''} initialId={params.id}/></StudioShell>;
}
