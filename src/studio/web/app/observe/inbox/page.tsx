import type { Metadata } from 'next';
import { requestInboxPage } from '../../../catalog';
import { InboxView } from '../../../components/inbox/inbox';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, studioLang } from '../../../components/layout/page-titles';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ lang?: string }> }): Promise<Metadata> {
  return pageTitle('inbox', studioLang(await searchParams));
}

export default async function Page({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const lang = studioLang(await searchParams);
  return (
    <StudioShell lang={lang} active="observe">
      <InboxView model={requestInboxPage().model} lang={lang} />
    </StudioShell>
  );
}
