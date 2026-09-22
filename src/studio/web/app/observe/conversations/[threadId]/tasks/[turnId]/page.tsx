import type { Metadata } from 'next';
import { requestObservePage } from '../../../../../../catalog';
import { ObserveView } from '../../../../../../components/observe/observe';
import { pageTitle, requestStudioLang } from '../../../../../../components/layout/page-titles';
import { DEFAULT_TRAJECTORY_TAB, parseTab, TRAJECTORY_TABS } from '../../../../../../../http/page-params';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{threadId: string; turnId: string}> }): Promise<Metadata> {
  const { threadId, turnId } = await params;
  return pageTitle('task', await requestStudioLang(), `${threadId}/${turnId}`);
}
// 面板在 RSC 里读地址，不留给客户端自己看 location：否则服务端渲染出默认面板、水合后换成地址里
// 那个，用户第一帧看到的是错的界面，分享出去的链接在打开瞬间也是错的。
export default async function Page({ searchParams }: { searchParams: Promise<{tab?: string}> }) {
  const params = await searchParams;
  const lang = await requestStudioLang();
  return <ObserveView page={requestObservePage()} lang={lang} initialTab={parseTab(params.tab, TRAJECTORY_TABS, DEFAULT_TRAJECTORY_TAB)}/>;
}
