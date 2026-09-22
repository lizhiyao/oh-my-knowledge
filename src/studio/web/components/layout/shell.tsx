'use client';
import Link from 'next/link';
import { StudioUtilities } from './utilities';
import { useEffect, useState, type ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import { AGENTS_INDEX_PATH, KNOWLEDGE_INDEX_PATH, MEASURE_INDEX_PATH, OBSERVE_INDEX_PATH } from '../../../http/page-paths';
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

/** 折叠／展开共用同一枚 panel 图标，方向由 CSS 按状态翻转，保证两个状态视觉上互为镜像。 */
function PanelIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9.5" y1="4" x2="9.5" y2="20"/></svg>;
}

export function StudioShell({ lang, children, active, sidebar }: { lang: Language; children: ReactNode; active: 'observe' | 'measure' | 'knowledge' | 'agents' | false; sidebar?: ReactNode }) {
  const navigation = useStudioNavigation();
  const zh = lang === 'zh';
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(readCollapsed()); }, []);
  function toggleCollapsed() {
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
        <button type="button" className="studio-sidebar-toggle" aria-expanded={open} aria-label={zh ? '打开导航与列表' : 'Open navigation and lists'} onClick={() => setOpen(value => !value)}>☰</button>
        <Link className="studio-brand" href={studioEntryPath(true)} aria-label="OMK Studio"><span className="studio-mark">omk</span><span>OMK Studio</span></Link>
      </header>
      <aside className="studio-sidebar" onClick={event => { if ((event.target as HTMLElement).closest('a')) setOpen(false); }}>
        <div className="studio-sidebar-head">
          <Link className="studio-brand" href={studioEntryPath(true)} aria-label="OMK Studio"><span className="studio-mark">omk</span><span>OMK Studio</span></Link>
          <button type="button" className="studio-sidebar-collapse" aria-label={zh ? '收起侧栏' : 'Collapse sidebar'} title={zh ? '收起侧栏' : 'Collapse sidebar'} onClick={toggleCollapsed}><PanelIcon/></button>
        </div>
        <nav aria-label={zh ? 'Studio 一级导航' : 'Studio primary navigation'}>
          <Link href={OBSERVE_INDEX_PATH} aria-current={active === 'observe' ? 'page' : undefined}>{zh ? '观测' : 'Observe'}</Link>
          <Link href={MEASURE_INDEX_PATH} aria-current={active === 'measure' ? 'page' : undefined}>{zh ? '评测' : 'Measure'}</Link>
          <Link href={KNOWLEDGE_INDEX_PATH} aria-current={active === 'knowledge' ? 'page' : undefined}>{zh ? '知识' : 'Knowledge'}</Link>
          <Link href={AGENTS_INDEX_PATH} aria-current={active === 'agents' ? 'page' : undefined}>{zh ? 'Agent' : 'Agents'}</Link>
        </nav>
        {sidebar ? <div className="studio-sidebar-body">{sidebar}</div> : null}
        <StudioUtilities lang={lang}/>
      </aside>
      <main className="studio-content">
        {collapsed ? <button type="button" className="studio-sidebar-expand" aria-label={zh ? '展开侧栏' : 'Expand sidebar'} title={zh ? '展开侧栏' : 'Expand sidebar'} onClick={toggleCollapsed}><PanelIcon/></button> : null}
        {children}
      </main>
    </div>
  </ConfigProvider>;
}
