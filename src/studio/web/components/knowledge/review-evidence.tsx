'use client';
import { useState } from 'react';
import { Alert, Button, Input, InputNumber, Select } from 'antd';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { KnowledgeReviewUseInput } from '../../../view-models/knowledge/knowledge-reviews';
import { locateQuoteOccurrence } from '../../../../knowledge/extraction/quote-occurrence';
import type { Language } from '../layout/shell';

type Evidence = NonNullable<KnowledgeReviewUseInput['evidence']>[number];
/** Optional review evidence can cite a missing statement in the original, beyond existing body quotes. */
export function KnowledgeReviewEvidence({ detail, value, onChange, lang, disabled }: {
  detail: KnowledgeCandidateDetail; value: Evidence[]; onChange(value: Evidence[]): void; lang: Language; disabled: boolean;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const choices = detail.sources.flatMap((source, sourceIndex) => source.status === 'available' ? source.window.excerpts.map(excerpt => ({
    value: JSON.stringify([source.window.snapshotId, source.window.sourceVersion, excerpt.evidenceRef]),
    label: `${t(`来源 ${sourceIndex + 1}`, `Source ${sourceIndex + 1}`)} · ${source.window.origin?.title || source.window.snapshotId.slice(0, 8)} · ${excerpt.recordIndex} · ${excerpt.role ?? excerpt.eventKind} · ${excerpt.text.slice(0, 70)}`,
    source: { snapshotId: source.window.snapshotId, sourceVersion: source.window.sourceVersion }, excerpt,
  })) : []);
  const [selected, setSelected] = useState(choices[0]?.value ?? ''), [quote, setQuote] = useState('');
  const [occurrence, setOccurrence] = useState<number | null>(null), [basis, setBasis] = useState<Evidence['basis']>('source_assertion');
  const [interpretation, setInterpretation] = useState('');
  const choice = choices.find(item => item.value === selected);
  const located = choice && quote.trim() ? locateQuoteOccurrence({ evidenceRef: choice.excerpt.evidenceRef, quote, ...(occurrence === null ? {} : { occurrence }) }, [choice.excerpt]) : undefined;
  return <details className="knowledge-review-evidence"><summary>{t(`原始来源依据（可选，已选 ${value.length} 条）`, `Original-source evidence (optional, ${value.length} selected)`)}</summary>
    {value.map((evidence, index) => <section className="candidate-statement" key={index}><blockquote>{evidence.selection.quote}</blockquote><p className="candidate-help"><code>{evidence.source.snapshotId} / {evidence.source.sourceVersion}</code> · {evidence.selection.evidenceRef} · {evidence.selection.start}–{evidence.selection.end}</p><Button disabled={disabled} onClick={() => onChange(value.filter((_, at) => at !== index))}>{t(`移除依据 ${index + 1}`, `Remove evidence ${index + 1}`)}</Button></section>)}
    {!choices.length ? <Alert type="warning" title={t('原始来源不可读；可先记录复核意见，不能添加未经定位的引文。', 'Original sources are unavailable. You can record an opinion without adding an unlocated quotation.')}/> : <div className="candidate-form">
      <label>{t('选择原始消息', 'Choose an original message')}<Select aria-label={t('复核依据的原始消息', 'Original message for review evidence')} disabled={disabled} value={selected} options={choices} onChange={value => { setSelected(value); setQuote(''); setOccurrence(null); }}/></label>
      {choice && <p className="candidate-help" aria-label={t('当前复核依据的精确来源身份','Exact source identity for the current review evidence')}><code>{choice.source.snapshotId} / {choice.source.sourceVersion} / {choice.excerpt.evidenceRef}</code></p>}
      {choice && <Input.TextArea aria-label={t('复核原始消息（只读）', 'Original review message (read-only)')} className="entity-source-text" readOnly rows={6} value={choice.excerpt.text}/>}
      <label>{t('逐字引文', 'Exact quotation')}<Input.TextArea aria-label={t('复核逐字引文', 'Exact review quotation')} disabled={disabled} rows={3} value={quote} onChange={event => setQuote(event.target.value)}/></label>
      <label>{t('出现序号（从 0 开始，可留空）', 'Occurrence (starting at 0, optional)')}<InputNumber aria-label={t('复核引文出现序号', 'Review quotation occurrence')} min={0} precision={0} value={occurrence} disabled={disabled} onChange={setOccurrence}/></label>
      <label>{t('依据性质', 'Evidence basis')}<Select aria-label={t('复核依据性质', 'Review evidence basis')} disabled={disabled} value={basis} onChange={setBasis} options={[{ value: 'source_assertion', label: t('来源中的说法', 'Source assertion') }, { value: 'direct_observation', label: t('直接观测', 'Direct observation') }, { value: 'inference', label: t('推断', 'Inference') }]}/></label>
      <label>{t('依据解释（可选）', 'Evidence interpretation (optional)')}<Input disabled={disabled} value={interpretation} onChange={event => setInterpretation(event.target.value)}/></label>
      {quote && typeof located === 'string' && <Alert type="warning" title={t('引文尚未唯一定位。请核对原文；重复引文需明确出现序号。', 'The quotation is not uniquely located. Check the text and choose an occurrence for repeated quotations.')}/>}
      <Button disabled={disabled || !choice || !located || typeof located === 'string' || value.length >= 64} onClick={() => { if (!choice || !located || typeof located === 'string') return; onChange([...value, { source: choice.source, selection: located, basis, ...(interpretation.trim() ? { interpretation: interpretation.trim() } : {}) }]); setQuote(''); }}>{t('添加这条精确依据', 'Add this exact evidence')}</Button>
    </div>}
  </details>;
}
