'use client';
import Link from 'next/link';
import { StudioShell, studioEntryPath } from '../components/layout/shell';
import { useStudioNavigation } from '../components/layout/navigation';
import { useStudioLanguage } from '../components/layout/language';

/**
 * Next 自己的路由失配边界（客户端导航走到没有匹配路由的地址时渲染），不是站点的服务端缺页机制：
 * 宿主只接管自己认得的地址，未知地址落回 HTTP adapter 得到纯文本 404；「有路由但记录不存在」
 * 也在 Next 开始流式输出之前由宿主用专属码回答，因为根 `loading.tsx` 一旦先刷出壳层，段内的
 * `notFound()` 就改不掉 200 状态码（口径与实测见 #902 §三）。措辞不绑定某一分区，出口链接跟随宿主入口。
 */
export default function NotFound() {
  const lang = useStudioLanguage();
  const zh = lang === 'zh';
  const entry = studioEntryPath(useStudioNavigation());
  return <StudioShell lang={lang} active={false}><section>
    <h1>{zh ? '页面不存在' : 'Page not found'}</h1>
    <p>{zh ? '这个地址在本机宿主上没有对应的页面或记录。' : 'This address has no page or record on this host.'}</p>
    <Link href={entry}>{zh ? '返回 Studio 首页' : 'Back to Studio'}</Link>
  </section></StudioShell>;
}
