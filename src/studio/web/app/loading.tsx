'use client';
import { StudioShell } from '../components/layout/shell';
import { useStudioLanguage } from '../components/layout/language';

export default function Loading() {
  const lang = useStudioLanguage();
  return <StudioShell lang={lang} active={false}><div role="status">{lang === 'zh' ? '正在加载…' : 'Loading…'}</div></StudioShell>;
}
