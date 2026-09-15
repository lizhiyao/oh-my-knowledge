'use client';
import { createContext, useContext, type ReactNode } from 'react';
import type { Language } from './shell';

const StudioLanguageContext = createContext<Language>('zh');

// 同 StudioRouteProvider：值由宿主按请求注入。error.tsx 必须是客户端组件，拿不到 headers()，
// 只能从根布局传下来的这份上下文里读语言。
export function StudioLanguageProvider({ value, children }: { value: Language; children: ReactNode }) {
  return <StudioLanguageContext.Provider value={value}>{children}</StudioLanguageContext.Provider>;
}

export function useStudioLanguage(): Language {
  return useContext(StudioLanguageContext);
}
