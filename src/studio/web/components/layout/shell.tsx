'use client';
import Link from 'next/link';
import { StudioUtilities } from './utilities';
import { useState, type ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import { KNOWLEDGE_INDEX_PATH, MEASURE_INDEX_PATH, OBSERVE_INDEX_PATH } from '../../../http/page-paths';
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

export function StudioShell({ lang, children, active, utilitiesInSidebar = false }: { utilitiesInSidebar?: boolean; lang: Language; children: ReactNode; active: 'observe' | 'measure' | 'knowledge' | false }) {
  // 只挂 /measure 的宿主不提供兄弟路由组，渲染导航等于把用户导向 404；语言切换不依赖路由组，始终保留。
  const navigation = useStudioNavigation();
  return <ConfigProvider locale={lang === 'zh' ? zhCN : enUS}>
    <div className="studio-app"><header className="studio-header"><Link className="studio-brand" href={studioEntryPath(navigation)} aria-label="OMK Studio"><span className="studio-mark">omk</span><span>OMK Studio</span></Link>
      {navigation ? <nav aria-label={lang === 'zh' ? 'Studio 一级导航' : 'Studio primary navigation'}>
        <Link href={OBSERVE_INDEX_PATH} aria-current={active === 'observe' ? 'page' : undefined}>{lang === 'zh' ? '观测' : 'Observe'}</Link>
        <Link href={MEASURE_INDEX_PATH} aria-current={active === 'measure' ? 'page' : undefined}>{lang === 'zh' ? '评测' : 'Measure'}</Link>
        <Link href={KNOWLEDGE_INDEX_PATH} aria-current={active === 'knowledge' ? 'page' : undefined}>{lang === 'zh' ? '知识' : 'Knowledge'}</Link>
      </nav> : null}
      <div className="studio-global-actions">{navigation ? !utilitiesInSidebar && <StudioUtilities lang={lang} placement="bottomRight"/> : <LanguageSwitch lang={lang}/>}</div>
    </header><main className="studio-content">{children}</main></div>
  </ConfigProvider>;
}
