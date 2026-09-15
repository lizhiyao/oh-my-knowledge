import { headers } from 'next/headers';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { StudioTheme } from '../components/layout/theme';
import { StudioNavigationProvider } from '../components/layout/navigation';
import { StudioRouteProvider } from '../components/layout/current-route';
import { StudioLanguageProvider } from '../components/layout/language';
import './studio.css';

export const metadata: Metadata = { title: { default: 'OMK Studio', template: 'OMK · %s' }, description: 'Observe. Measure. Know.' };
export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const lang = requestHeaders.get('x-omk-studio-lang') === 'en' ? 'en' : 'zh-CN';
  const navigation = requestHeaders.get('x-omk-studio-navigation') !== 'none';
  const route = requestHeaders.get('x-omk-studio-route') ?? '';
  // 请求语言只在这里读一次：三张壳层回退页都是客户端组件（`error.tsx` 必须是，另两张跟随同一机制），
  // 拿不到 `headers()`，所以由这份上下文把同一个值发给它们，不在三处各写一遍默认中文。
  return <html lang={lang}><body><AntdRegistry><StudioLanguageProvider value={lang === 'en' ? 'en' : 'zh'}><StudioNavigationProvider value={navigation}><StudioRouteProvider value={route}><StudioTheme>{children}</StudioTheme></StudioRouteProvider></StudioNavigationProvider></StudioLanguageProvider></AntdRegistry></body></html>;
}
