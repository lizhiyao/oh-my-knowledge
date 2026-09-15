'use client';
import { StudioUtilities } from './utilities';
import type { ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { useStudioNavigation } from './navigation';
import { useStudioRoute } from './current-route';
export type Language = 'zh' | 'en';

/**
 * 由宿主注入的 `pathname?search` 生成目标语言地址：其余查询参数（如 `?doctorRun=`）
 * 必须跟着走，否则换语言会静默换掉所见证据。显式保留目标语言，避免全局偏好覆盖单次选择。
 */
export function languageSwitchHref(route: string, target: Language): string {
  const queryIndex = route.indexOf('?');
  const pathname = queryIndex < 0 ? route : route.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex < 0 ? '' : route.slice(queryIndex + 1));
  params.set('lang', target);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** 页面内静态链接的语言参数：语言一旦确定就跟着每次跳转走，缺省值只在地址没有 lang 时由全局设置决定。 */
export function langSuffix(lang: Language): string {
  return `?lang=${lang}`;
}

/** 宿主入口地址：挂了页面组的宿主从 `/` 进（HTTP adapter 302 到观测），只挂 `/measure` 的评测预览宿主没有兄弟路由，入口就是评测列表本身。 */
export function studioEntryPath(hasNavigation: boolean): string {
  return hasNavigation ? '/' : '/measure';
}

function LanguageSwitch({ lang }: { lang: Language }) {
  const route = useStudioRoute();
  if (!route) return null;
  const href = languageSwitchHref(route, lang === 'zh' ? 'en' : 'zh');
  return <a
    className="studio-lang"
    href={href}
    aria-label={lang === 'zh' ? '切换到英文界面' : 'Switch to the Chinese interface'}
    title={lang === 'zh' ? '当前语言：中文' : 'Current language: English'}
  >{lang === 'zh' ? '英文' : '中文'}</a>;
}

export function StudioShell({ lang, children, active, utilitiesInSidebar = false }: { utilitiesInSidebar?: boolean; lang: Language; children: ReactNode; active: 'observe' | 'measure' | 'knowledge' | false }) {
  const suffix = langSuffix(lang);
  // 只挂 /measure 的宿主不提供兄弟路由组，渲染导航等于把用户导向 404；语言切换不依赖路由组，始终保留。
  const navigation = useStudioNavigation();
  return <ConfigProvider locale={lang === 'zh' ? zhCN : enUS}>
    <div className="studio-app"><header className="studio-header"><a className="studio-brand" href={`${studioEntryPath(navigation)}${suffix}`} aria-label="OMK Studio"><span className="studio-mark">omk</span><span>OMK Studio</span></a>
      {navigation ? <nav aria-label={lang === 'zh' ? 'Studio 一级导航' : 'Studio primary navigation'}>
        <a href={`/observe${suffix}`} aria-current={active === 'observe' ? 'page' : undefined}>{lang === 'zh' ? '观测' : 'Observe'}</a>
        <a href={`/measure${suffix}`} aria-current={active === 'measure' ? 'page' : undefined}>{lang === 'zh' ? '评测' : 'Measure'}</a>
        <a href={`/knowledge${suffix}`} aria-current={active === 'knowledge' ? 'page' : undefined}>{lang === 'zh' ? '知识' : 'Knowledge'}</a>
      </nav> : null}
      <div className="studio-global-actions">{navigation ? !utilitiesInSidebar && <StudioUtilities lang={lang} placement="bottomRight"/> : <LanguageSwitch lang={lang}/>}</div>
    </header><main className="studio-content">{children}</main></div>
  </ConfigProvider>;
}
