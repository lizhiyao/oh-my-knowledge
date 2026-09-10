'use client';
import type { ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
export type Language = 'zh' | 'en';
export function StudioShell({ lang, children }: { lang: Language; children: ReactNode }) {
  const suffix = lang === 'en' ? '?lang=en' : '';
  return <ConfigProvider locale={lang === 'zh' ? zhCN : enUS}>
    <header className="studio-header"><a className="studio-brand" href={`/${suffix}`} aria-label="OMK Studio"><span className="studio-mark">omk</span><span>Studio</span></a>
      <nav aria-label={lang === 'zh' ? 'Studio 一级导航' : 'Studio primary navigation'}>
        <a href={`/observe${suffix}`}>{lang === 'zh' ? '观测' : 'Observe'}</a>
        <a href={`/measure${suffix}`} aria-current="page">{lang === 'zh' ? '评测' : 'Measure'}</a>
        <a href={`/knowledge${suffix}`}>{lang === 'zh' ? '知识' : 'Knowledge'}</a>
      </nav>
    </header><main className="studio-content">{children}</main>
  </ConfigProvider>;
}
