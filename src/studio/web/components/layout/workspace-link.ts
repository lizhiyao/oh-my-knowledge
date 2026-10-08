'use client';
import { useSearchParams } from 'next/navigation';

/** 操作目录随站内地址传递；不覆盖目标已明确指定的目录，也不成为浏览器全局偏好。 */
export function workspaceHref(href: string, workspace: string): string {
  if (!workspace || !href.startsWith('/') || href.startsWith('//')) return href;
  const url = new URL(href, 'http://studio.invalid');
  if (!url.searchParams.has('workspace')) url.searchParams.set('workspace', workspace);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useWorkspaceHref() {
  const workspace = useSearchParams()?.get('workspace') ?? '';
  return (href: string) => workspaceHref(href, workspace);
}
