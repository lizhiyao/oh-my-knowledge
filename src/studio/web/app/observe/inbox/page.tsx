import type { Metadata } from 'next';
import { requestInboxPage } from '../../../catalog';
import { InboxView } from '../../../components/observe/inbox/inbox';
import { StudioShell } from '../../../components/layout/shell';
import { pageTitle, requestStudioLang } from '../../../components/layout/page-titles';
import { DEFAULT_OBSERVE_INBOX_TAB, OBSERVE_INBOX_TABS, parseTab } from '../../../../http/page-params';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return pageTitle('inbox', await requestStudioLang());
}

// 面板在 RSC 里读地址，不留给客户端自己看 location：否则服务端渲染出默认面板、水合后换成地址里
// 那个，用户第一帧看到的是错的界面，分享出去的链接在打开瞬间也是错的。
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const params = await searchParams;
  const lang = await requestStudioLang();
  return (
    <StudioShell lang={lang} active="observe">
      <InboxView
        model={requestInboxPage().model}
        lang={lang}
        initialTab={parseTab(params.tab, OBSERVE_INBOX_TABS, DEFAULT_OBSERVE_INBOX_TAB)}
      />
    </StudioShell>
  );
}
