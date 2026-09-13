'use client';
import { createContext, useContext, type ReactNode } from 'react';

const StudioNavigationContext = createContext(true);

// Provider 必须在客户端模块里渲染：服务端组件引用 client 模块的 .Provider 会解析成 undefined。
export function StudioNavigationProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <StudioNavigationContext.Provider value={value}>{children}</StudioNavigationContext.Provider>;
}

export function useStudioNavigation(): boolean {
  return useContext(StudioNavigationContext);
}
