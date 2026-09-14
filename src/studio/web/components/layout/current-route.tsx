'use client';
import { createContext, useContext, type ReactNode } from 'react';

const StudioRouteContext = createContext('');

// 同 StudioNavigationProvider：Provider 必须在客户端模块里渲染，值由宿主按请求注入。
export function StudioRouteProvider({ value, children }: { value: string; children: ReactNode }) {
  return <StudioRouteContext.Provider value={value}>{children}</StudioRouteContext.Provider>;
}

/** 当前请求的 `pathname?search`，缺少注入时为空串。 */
export function useStudioRoute(): string {
  return useContext(StudioRouteContext);
}
