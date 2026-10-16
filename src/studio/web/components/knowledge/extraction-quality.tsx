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
  const rate = (value: number | null) => value === null ? t('未知／无分母', 'Unknown / no denominator') : `${(value * 100).toFixed(1)}%`;
  return <section className="candidate-form extraction-quality" aria-label={t('结构接纳统计', 'Admission statistics')}>
    <p className="candidate-help">{t('整个知识工作区，按首次接纳意图统计，每个运行计一次。读取不调用模型，不重判历史，也不采用后续人工修订。', 'Whole knowledge workspace; saved birth admission, once per run. Reading calls no model, rechecks no history, and excludes later human edits.')}</p>
    <p className="candidate-help">{t('位置匹配不证明语义准确；引用／依赖拒绝不是因果级联；零接纳不代表质量通过。', 'Position matches do not prove semantic accuracy; reference/dependency rejections are not causal cascades; zero admission is not a quality pass.')}</p>
    {loading ? <Skeleton active paragraph={{ rows: 3 }}/>
      : failed ? <Alert type="warning" title={t('统计暂不可读；不能据此判断没有运行或拒绝。', 'Statistics unavailable; this does not mean there are no runs or rejections.')}
        action={<Button onClick={onRetry}>{t('重新读取统计', 'Reload statistics')}</Button>}/>
        : quality && <>
          <Button size="small" onClick={onRetry}>{t('重新读取统计', 'Reload statistics')}</Button>
          <p>{t(`共 ${quality.runCount} 次运行，${quality.groups.length} 组测量来源。`, `${quality.runCount} runs, ${quality.groups.length} measurement-source groups.`)}</p>
          {!quality.groups.length && <p>{t('尚无提炼运行。提炼后可在此核对结构接纳记录；空库不是质量通过。', 'No extraction runs yet. Inspect saved admission after extraction; an empty workspace is not a quality pass.')}</p>}
          {quality.groups.map(group => <details className="candidate-statement" key={JSON.stringify(group.identity)}>
            <summary>{group.identity.promptVersion} · {group.identity.executor} / {group.identity.model} · {group.runs.total} {t('次运行', 'runs')}</summary>
            <p className="extraction-quality-identity">Schema {group.identity.schemaVersion} · {group.identity.promptHash}</p>
            <p>{t(`已完成 ${group.runs.completed}，已准备 ${group.runs.prepared}，生成中 ${group.runs.generating}，失败 ${group.runs.failed}，取消 ${group.runs.cancelled}。`, `Completed ${group.runs.completed}, prepared ${group.runs.prepared}, generating ${group.runs.generating}, failed ${group.runs.failed}, cancelled ${group.runs.cancelled}.`)}</p>
            <p>{t(`有首次接纳记录 ${group.runs.withAdmission}，未形成记录 ${group.runs.withoutAdmission}；零接纳 ${group.runs.zeroAccepted}，零知识提案接纳 ${group.runs.zeroKnowledge}。`, `Birth admission recorded ${group.runs.withAdmission}, not recorded ${group.runs.withoutAdmission}; zero admission ${group.runs.zeroAccepted}, zero knowledge proposal admission ${group.runs.zeroKnowledge}.`)}</p>
            {(['entities', 'mentions', 'proposals'] as const).map(component => <p key={component}>
              <strong>{component === 'entities' ? t('实体接纳', 'Entity admission') : component === 'mentions' ? t('提及接纳', 'Mention admission') : t('知识提案接纳', 'Knowledge proposal admission')}</strong>{'：'}
              {group[component].accepted} / {group[component].recorded} · {rate(group[component].acceptanceRate)}{' · '}
              {t(`${group[component].unknownRuns} 次分母未知`, `${group[component].unknownRuns} runs with unknown denominators`)}
            </p>)}
            <p><strong>{t('逐字定位：通过／拒绝／未检查／未知', 'Exact localization: passed / rejected / not checked / unknown')}</strong>{'：'}
              {group.localization.passed} / {group.localization.rejected} / {group.localization.notChecked} / {group.localization.unknown}</p>
            <p>{t('已知定位检查通过率', 'Known localization check pass rate')}{'：'}{rate(group.localization.passRate)}{' · '}
              {t(`${group.localization.unknownRuns} 次检查记录未知`, `${group.localization.unknownRuns} runs with unknown check records`)}</p>
            <p className="candidate-help">{t('未检查项不进入定位分母。未知理由或缺失历史记录会使通过率未知，不推断未保存的校验事件。', 'Not-checked items are excluded from the localization denominator. Unknown reasons or missing history make the rate unknown; unsaved check events are not inferred.')}</p>
            <p>{t('标识符碎片拒绝', 'Identifier-fragment rejections')}{'：'}{group.identifierFragmentRejections} · {rate(group.identifierFragmentRejectionRate)}{'；'}
              {t('引用／依赖拒绝项', 'Reference/dependency rejected items')}{'：'}{group.referenceRejections}</p>
            <details><summary>{t('逐项拒绝理由计数', 'Rejection reason counts')}</summary>
              <p className="candidate-help">{t('同一项可有多个理由，理由数量不能相加当作独立错误。', 'One item may have multiple reasons; reason counts are not independent errors.')}</p>
              <ul>{group.reasons.map(reason => <li key={`${reason.component}:${reason.reason}`}>{reason.component} / {reason.reason}：{reason.count}</li>)}</ul>
            </details>
          </details>)}
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
  return <details><summary>{lang === 'zh' ? '结构接纳统计（零模型调用）' : 'Admission statistics (no model calls)'}</summary>
    <ExtractionQualityView quality={quality} loading={loading} failed={failed} lang={lang} onRetry={() => setRetry(value => value + 1)}/>
  </details>;
}
