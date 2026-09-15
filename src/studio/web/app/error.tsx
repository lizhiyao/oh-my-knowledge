'use client';
import { StudioShell } from '../components/layout/shell';
import { useStudioLanguage } from '../components/layout/language';
import { Button, Result } from 'antd';
export default function ErrorPage({ reset }: {reset: () => void}) {
  const lang = useStudioLanguage();
  const zh = lang === 'zh';
  return <StudioShell lang={lang} active={false}><Result status="error" title={zh ? '页面暂时无法加载' : 'Unable to load page'} extra={<Button onClick={reset}>{zh ? '重试' : 'Retry'}</Button>}/></StudioShell>;
}
