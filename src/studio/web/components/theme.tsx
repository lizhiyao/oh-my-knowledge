'use client';
import { App, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
export function StudioTheme({ children }: { children: ReactNode }) {
  return <ConfigProvider theme={{ token: { colorPrimary: '#5145cd', colorText: '#192236', colorBgLayout: '#f7f8fb', borderRadius: 6, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif' } }}><App>{children}</App></ConfigProvider>;
}
