'use client';
import { StudioShell, langSuffix } from '../components/layout/shell';
import { useStudioLanguage } from '../components/layout/language';

export default function NotFound() {
  const lang = useStudioLanguage();
  const zh = lang === 'zh';
  return <StudioShell lang={lang} active={false}><section><h1>{zh ? '运行记录不存在' : 'Run not found'}</h1><a href={`/measure${langSuffix(lang)}`}>{zh ? '返回评测' : 'Back to Measure'}</a></section></StudioShell>;
}
