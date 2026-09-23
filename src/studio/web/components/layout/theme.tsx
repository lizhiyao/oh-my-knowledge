'use client';
import { App, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
export function StudioTheme({ children }: { children: ReactNode }) {
  return <ConfigProvider theme={{ token: { colorPrimary: '#7753ff', colorLink: '#5a3cdb', colorLinkHover: '#6745eb', colorTextSecondary: '#657085', colorTextTertiary: '#5f6b7f', colorSuccess: '#14795a', colorWarning: '#a1560b', colorError: '#b42318', colorSuccessBg: '#e6f4ee', colorWarningBg: '#fdf1e3', colorErrorBg: '#fbeae8', colorSuccessBorder: '#bfe0d1', colorWarningBorder: '#f2ddbd', colorErrorBorder: '#f0cdc8', colorText: '#192236', colorBgLayout: '#f7f8fb', borderRadius: 6, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif' }, components: { Tabs: { itemSelectedColor: '#5a3cdb', itemHoverColor: '#5a3cdb', inkBarColor: '#7753ff' }, Button: { colorPrimaryHover: '#6745eb' } } }}><App>{children}</App></ConfigProvider>;
}
