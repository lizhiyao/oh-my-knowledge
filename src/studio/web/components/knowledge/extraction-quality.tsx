'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Skeleton } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateRun, KnowledgeExtractionQuality } from '../../../view-models/knowledge/knowledge-candidates';
import { requestKnowledge } from './request';
import { generationStageLabel } from './source-picker';

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
          <p>{t(`当前流程 ${quality.current.length} 次运行；旧格式 ${quality.unsupported.length} 次；不可读 ${quality.unavailable.length} 次。旧格式和不可读记录未混入当前统计。`, `${quality.current.length} current runs; ${quality.unsupported.length} unsupported older runs; ${quality.unavailable.length} unavailable records. Unsupported and unavailable records are excluded from current counts.`)}</p>
          {quality.unavailable.length > 0 && <Alert type="warning" title={t('部分提炼记录不可读，当前统计可能不完整。', 'Some extraction records are unavailable. Current counts may be incomplete.')}/>}
          {!quality.current.length && <p>{t('暂无当前流程记录。', 'No current workflow records.')}</p>}
          {quality.current.map(run => <details key={run.runId}><summary>{run.runId} · {run.status} · {t(`已存 ${run.savedBodies} 条正文`, `${run.savedBodies} saved bodies`)}</summary>
            {run.phases.map((phase, index) => <p key={index}>{generationStageLabel(phase.stageKind, lang)} · {phase.state} · {t('未接纳输出', 'Rejected outputs')}：{phase.rejected ?? t('未知', 'Unknown')}{phase.issues.length ? ` · ${phase.issues.join('；')}` : ''}</p>)}
            <NativeArchiveChecks checks={quality.archiveChecks.filter(check => check.runId === run.runId)} verification="not_verified" lang={lang}/>
          </details>)}
          <Button size="small" onClick={onRetry}>{t('重新读取', 'Reload')}</Button>
        </>}
  </section>;
}

/** Metadata observations must stay distinct from full archive integrity checks. */
export function NativeArchiveChecks({ checks, verification, lang }: {
  checks: KnowledgeCandidateRun['archiveChecks']; verification: KnowledgeCandidateRun['archiveVerification']; lang: Language;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const labels = {
    not_recorded: t('尚无归档引用', 'No archive reference recorded'),
    present: t('文件存在，内容未核验', 'File present; content not verified'),
    missing: t('归档缺失', 'Archive missing'),
    invalid: t('归档文件元数据不匹配', 'Archive file metadata does not match'),
    unknown: t('归档状态未知', 'Archive state unknown'),
  };
  return <div className="candidate-help">
    <p>{verification === 'verified' ? t('原始归档已完成完整性核验；这不代表知识内容已经核对。', 'Native archive integrity was verified. This does not establish reviewed knowledge content.')
      : t('原始归档尚未完整核验；文件存在不代表内容有效。', 'Native archives have not been fully verified; file presence does not establish valid content.')}</p>
    {checks.map(check => <p key={check.invocationId}><code>{check.invocationId}</code> · {labels[check.archiveStatus]}</p>)}
  </div>;
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
