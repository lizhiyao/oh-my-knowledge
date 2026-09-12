import { requestInboxPage } from '../../../catalog';
import { InboxView } from '../../../components/inbox/inbox';
import { StudioShell } from '../../../components/layout/shell';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const lang = (await searchParams).lang === 'en' ? 'en' : 'zh';
  return (
    <StudioShell lang={lang} active="observe">
      <InboxView model={requestInboxPage().model} lang={lang} />
    </StudioShell>
  );
}
