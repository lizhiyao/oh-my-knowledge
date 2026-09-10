import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { StudioTheme } from '../components/theme';
import './studio.css';

export const metadata = { title: 'OMK Studio', description: 'Observe. Measure. Know.' };
export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = (await headers()).get('x-omk-studio-lang') === 'en' ? 'en' : 'zh-CN';
  return <html lang={lang}><body><AntdRegistry><StudioTheme>{children}</StudioTheme></AntdRegistry></body></html>;
}
