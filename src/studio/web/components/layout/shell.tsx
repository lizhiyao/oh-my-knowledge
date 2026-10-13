'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { workspaceHref } from './workspace-link';
import { StudioUtilities } from './utilities';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import { KNOWLEDGE_LIBRARY_PATH, MEASURE_INDEX_PATH, OBSERVE_INDEX_PATH } from '../../../http/page-paths';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { useStudioNavigation } from './navigation';
import { saveStudioLanguage } from './switch-language';
export type Language = 'zh' | 'en';

/** 宿主入口地址：挂了页面组的宿主从 `/` 进（HTTP adapter 302 到观测），只挂 `/measure` 的评测预览宿主没有兄弟路由，入口就是评测列表本身。 */
export function studioEntryPath(hasNavigation: boolean): string {
  return hasNavigation ? '/' : MEASURE_INDEX_PATH;
}

/**
 * 语言是本机设置，不进地址：切换 = 写设置文件后重载当前页，地址与其余查询参数（如 `?doctorRun=`）
 * 原样保留。只有宿主裁掉一级导航（没有设置抽屉入口）时才渲染这个独立控件；失败留在原页可重试。
 */
function LanguageSwitch({ lang }: { lang: Language }) {
  const zh = lang === 'zh';
  const target: Language = zh ? 'en' : 'zh';
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function switchLanguage() {
    setBusy(true); setFailed(false);
    if (await saveStudioLanguage(target)) { window.location.reload(); return; }
    setBusy(false); setFailed(true);
  }
  return <button type="button" className="studio-lang" disabled={busy} onClick={() => void switchLanguage()}
    aria-label={zh ? '切换到英文界面' : 'Switch to the Chinese interface'}
    title={failed ? (zh ? '语言切换失败，点按重试' : 'Language switch failed; select to retry') : (zh ? '当前语言：中文' : 'Current language: English')}
  >{zh ? '英文' : '中文'}</button>;
}

/**
 * Studio 外壳（#1055）：左侧栏承载品牌、一级导航与各工作区列表，设置与帮助固定侧栏底部；
 * 主区只放当前选中内容。工作区把自己的列表（对话、评测运行）经 `sidebar` 交给外壳渲染，
 * 页面不得自画入口（架构门禁守）。
 *
 * 只挂 `/measure` 的预览宿主没有兄弟路由，保留无导航的紧凑页头，不侧栏化。
 *
 * 品牌链接在三个分支各自内联书写：抽组件接 `href` 会把跳转的归属从 next/link 挪到自定义组件，
 * 站内跳转守门（studio-internal-navigation）认不出，宁可重复三行。
 */
/**
 * 侧栏折叠偏好只存在这台机器的浏览器里：SSR 永远按展开渲染，水合后读回偏好再收起——
 * 首帧可能闪一下展开态，换来的是地址与文档不带布局偏好、分享出去的链接渲染一致。
 */
const SIDEBAR_COLLAPSED_KEY = 'omk.studio.sidebarCollapsed';

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
}

/** 图标跟随状态：收起按钮是「面板 + 指向面板的左箭头」，展开按钮是「面板 + 离开面板的右箭头」，两态互换即语义互逆。 */
function PanelIcon({ direction }: { direction: 'collapse' | 'expand' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2"/>
    <line x1="9.5" y1="4" x2="9.5" y2="20"/>
    {direction === 'collapse' ? <polyline points="16.5 9.5 13.5 12 16.5 14.5"/> : <polyline points="12.5 9.5 15.5 12 12.5 14.5"/>}
  </svg>;
}

function NavigationIcon({ area }: { area: 'observe' | 'measure' | 'knowledge' | 'menu' }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {area === 'observe' ? <><path d="M3 5h18v14H3zM3 9h18M7 13h4M7 16h8"/></> : area === 'measure' ? <path d="M4 20V4M4 20h17M8 15V9M13 15V5M18 15v-4"/> : area === 'knowledge' ? <path d="M12 5v15M3 4h5c2 0 4 1 4 2 0-1 2-2 4-2h5v15h-5c-2 0-4 1-4 1s-2-1-4-1H3z"/> : <path d="M4 6h16M4 12h16M4 18h16"/>}
  </svg>;
}

export function StudioShell({ lang, children, active, sidebar }: { lang: Language; children: ReactNode; active: 'observe' | 'measure' | 'knowledge' | 'agents' | false; sidebar?: ReactNode }) {
  const navigation = useStudioNavigation();
  const workspace = useSearchParams()?.get('workspace') ?? '';
  const href = (path: string) => workspaceHref(path, workspace);
  const zh = lang === 'zh';
  const [open, setOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const drawerToggle = useRef<HTMLButtonElement>(null);
  const sidebarElement = useRef<HTMLElement>(null);
  useEffect(() => { setCollapsed(readCollapsed()); }, []);
  // 抽屉是覆盖在内容上的，读者要能不回到页头就把它收掉：Esc 与遮罩点击都关闭，
  // 关闭后焦点回到触发它的那个按钮，否则键盘读者会掉回页面顶部重新找。
  useEffect(() => {
    if (!open) return;
    sidebarElement.current?.querySelector<HTMLElement>('a,button')?.focus();
    function onKeyDown(event: KeyboardEvent) {
      const sidebar = sidebarElement.current;
      // Settings/help portals manage their own focus and Escape; do not trap them in navigation.
      if (!sidebar?.contains(event.target as Node)) return;
      if (event.key === 'Escape') { setOpen(false); drawerToggle.current?.focus(); }
      if (event.key === 'Tab') {
        const items = [...sidebar.querySelectorAll<HTMLElement>('a,button,input,summary,[tabindex="0"]')].filter(item => item.getClientRects().length && !item.hasAttribute('disabled'));
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width:861px)');
    const closeOnDesktop = () => { setNarrow(!desktop.matches); if (desktop.matches) setOpen(false); };
    closeOnDesktop();
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
  function toggleCollapsed() {
    if (window.matchMedia('(max-width:860px)').matches) { setOpen(false); drawerToggle.current?.focus(); return; }
    setCollapsed(value => {
      const next = !value;
      try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* 偏好写不进就当次会话生效 */ }
      return next;
    });
  }
  if (!navigation) {
    return <ConfigProvider locale={zh ? zhCN : enUS}>
      <div className="studio-app studio-app--flat"><header className="studio-header"><Link className="studio-brand" href={studioEntryPath(false)} aria-label="OMK Studio"><span className="studio-mark">omk</span><span>OMK Studio</span></Link>
        <div className="studio-global-actions"><LanguageSwitch lang={lang}/></div>
      </header><main className="studio-content">{children}</main></div>
    </ConfigProvider>;
  }
  return <ConfigProvider locale={zh ? zhCN : enUS}>
    <div className={`studio-app${open ? ' sidebar-open' : ''}${collapsed ? ' sidebar-collapsed' : ''}`}>
      <header className="studio-mobile-bar">
        <button ref={drawerToggle} type="button" className="studio-sidebar-toggle" aria-expanded={open} aria-controls="studio-sidebar" aria-label={zh ? '打开导航与列表' : 'Open navigation and lists'} onClick={() => setOpen(value => !value)}><NavigationIcon area="menu"/></button>
        <Link className="studio-brand" href={href(studioEntryPath(true))} aria-label="OMK Studio"><span className="studio-mark">omk</span><span>OMK Studio</span></Link>
      </header>
      {open ? <div className="studio-scrim" aria-hidden="true" onClick={() => { setOpen(false); drawerToggle.current?.focus(); }}/> : null}
      <aside ref={sidebarElement} id="studio-sidebar" className="studio-sidebar" inert={narrow && !open} role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-label={zh ? '导航与工作区' : 'Navigation and workspace'} onClick={event => { if ((event.target as HTMLElement).closest('a')) setOpen(false); }}>
        <div className="studio-sidebar-head">
          <Link className="studio-brand" href={href(studioEntryPath(true))} aria-label="OMK Studio"><span className="studio-mark">omk</span><span>OMK Studio</span></Link>
          <button type="button" className="studio-sidebar-collapse" aria-label={open ? (zh ? '关闭导航与列表' : 'Close navigation and lists') : collapsed ? (zh ? '展开侧栏' : 'Expand sidebar') : (zh ? '收起侧栏' : 'Collapse sidebar')} onClick={toggleCollapsed}><PanelIcon direction={collapsed ? 'expand' : 'collapse'}/></button>
        </div>
        <nav aria-label={zh ? 'Studio 一级导航' : 'Studio primary navigation'}>
          <Link href={href(OBSERVE_INDEX_PATH)} aria-label={zh ? '观测' : 'Observe'} title={zh ? '观测' : 'Observe'} aria-current={active === 'agents' ? 'location' : active === 'observe' ? 'page' : undefined}><NavigationIcon area="observe"/><span>{zh ? '观测' : 'Observe'}</span></Link>
          <Link href={href(MEASURE_INDEX_PATH)} aria-label={zh ? '评测' : 'Measure'} title={zh ? '评测' : 'Measure'} aria-current={active === 'measure' ? 'page' : undefined}><NavigationIcon area="measure"/><span>{zh ? '评测' : 'Measure'}</span></Link>
          <Link href={href(KNOWLEDGE_LIBRARY_PATH)} aria-label={zh ? '知识' : 'Knowledge'} title={zh ? '知识' : 'Knowledge'} aria-current={active === 'knowledge' ? 'page' : undefined}><NavigationIcon area="knowledge"/><span>{zh ? '知识' : 'Knowledge'}</span></Link>
        </nav>
        {sidebar ? <div className="studio-sidebar-body">{sidebar}</div> : null}
        <StudioUtilities lang={lang}/>
      </aside>
      <main className="studio-content" inert={open}>
        {children}
      </main>
    </div>
  </ConfigProvider>;
}
