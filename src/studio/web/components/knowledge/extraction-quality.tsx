'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Skeleton } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeExtractionQuality } from '../../../view-models/knowledge/knowledge-candidates';
import { requestKnowledge } from './request';

/** The domain owns every count and ratio. This component only presents its projection. */
export function ExtractionQualityView({ quality, loading, failed, onRetry, lang }: {
  quality?: KnowledgeExtractionQuality; loading: boolean; failed: boolean; onRetry(): void; lang: Language;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <section className="candidate-form extraction-quality" aria-label={t('保存与关联记录', 'Content and association records')}>
    <p>{t('这里只显示正文保存和关联执行记录，不能据此判断知识是否准确、有用。', 'These are content publication and association execution records. They do not establish accuracy or usefulness.')}</p>
    {loading ? <Skeleton active paragraph={{ rows: 3 }}/>
      : failed ? <Alert type="warning" title={t('记录暂不可读。', 'Records unavailable.')} action={<Button onClick={onRetry}>{t('重新读取', 'Reload')}</Button>}/>
        : quality && <>
          <p>{t(`当前流程 ${quality.current.length} 次运行；旧格式 ${quality.unsupported.length} 次，未混入当前统计。`, `${quality.current.length} current runs; ${quality.unsupported.length} unsupported older runs, excluded from current counts.`)}</p>
          {!quality.current.length && <p>{t('暂无当前流程记录。', 'No current workflow records.')}</p>}
          {quality.current.map(run => <details key={run.runId}><summary>{run.runId} · {run.status} · {t(`已存 ${run.savedBodies} 条正文`, `${run.savedBodies} saved bodies`)}</summary>
            {run.phases.map((phase, index) => <p key={index}>{phase.stageKind === 'body' ? t('正文', 'Content') : t('关联', 'Associations')} · {phase.state} · {t('未接纳输出', 'Rejected outputs')}：{phase.rejected ?? t('未知', 'Unknown')}{phase.issues.length ? ` · ${phase.issues.join('；')}` : ''}</p>)}
          </details>)}
          <Button size="small" onClick={onRetry}>{t('重新读取', 'Reload')}</Button>
        </>}
  </section>;
}

export function ExtractionQualityPanel({ workspace, lang }: { workspace: string; lang: Language }) {
  const [quality, setQuality] = useState<KnowledgeExtractionQuality>();
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === workspace) setRetry(value => value + 1); };
    window.addEventListener('omk-knowledge-changed', changed);
    return () => window.removeEventListener('omk-knowledge-changed', changed);
  }, [workspace]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setFailed(false); setQuality(undefined);
    void requestKnowledge<KnowledgeExtractionQuality>('candidates', { workspace, operation: 'quality' }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setQuality(value); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspace, retry]);
  return <details><summary>{lang === 'zh' ? '保存与关联记录' : 'Content and association records'}</summary>
    <ExtractionQualityView quality={quality} loading={loading} failed={failed} lang={lang} onRetry={() => setRetry(value => value + 1)}/>
  </details>;
}
