import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { StudioTheme } from '../components/layout/theme';
import { StudioNavigationProvider } from '../components/layout/navigation';
import { StudioRouteProvider } from '../components/layout/current-route';
import './studio.css';

export const metadata = { title: 'OMK Studio', description: 'Observe. Measure. Know.' };
export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const lang = requestHeaders.get('x-omk-studio-lang') === 'en' ? 'en' : 'zh-CN';
  const navigation = requestHeaders.get('x-omk-studio-navigation') !== 'none';
  const route = requestHeaders.get('x-omk-studio-route') ?? '';
  return <html lang={lang}><body><AntdRegistry><StudioNavigationProvider value={navigation}><StudioRouteProvider value={route}><StudioTheme>{children}</StudioTheme></StudioRouteProvider></StudioNavigationProvider></AntdRegistry></body></html>;
}
