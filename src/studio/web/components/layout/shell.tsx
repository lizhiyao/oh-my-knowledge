'use client';
import type { ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { useStudioNavigation } from './navigation';
export type Language = 'zh' | 'en';
export function StudioShell({ lang, children, active }: { lang: Language; children: ReactNode; active: 'observe' | 'measure' | 'knowledge' | false }) {
  const suffix = lang === 'en' ? '?lang=en' : '';
  // 只挂 /measure 的宿主不提供兄弟路由组，渲染导航等于把用户导向 404。
  const navigation = useStudioNavigation();
  return <ConfigProvider locale={lang === 'zh' ? zhCN : enUS}>
    <div className="studio-app"><header className="studio-header"><a className="studio-brand" href={`/${navigation ? '' : 'measure'}${suffix}`} aria-label="OMK Studio"><span className="studio-mark">omk</span><span>OMK Studio</span></a>
      {navigation ? <nav aria-label={lang === 'zh' ? 'Studio 一级导航' : 'Studio primary navigation'}>
        <a href={`/observe${suffix}`} aria-current={active === 'observe' ? 'page' : undefined}>{lang === 'zh' ? '观测' : 'Observe'}</a>
        <a href={`/measure${suffix}`} aria-current={active === 'measure' ? 'page' : undefined}>{lang === 'zh' ? '评测' : 'Measure'}</a>
        <a href={`/knowledge${suffix}`} aria-current={active === 'knowledge' ? 'page' : undefined}>{lang === 'zh' ? '知识' : 'Knowledge'}</a>
      </nav> : null}
    </header><main className="studio-content">{children}</main></div>
  </ConfigProvider>;
}
