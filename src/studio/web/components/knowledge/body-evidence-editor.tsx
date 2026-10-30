'use client';
import { useState } from 'react';
import { Alert, Button, Input, InputNumber, Select } from 'antd';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { Language } from '../layout/shell';
import { SourceLocator, locateSourceQuoteOccurrence, sourceCoordinateLabel, sourceMaterialLabel, sourceTextAreaOffset, sourceTextAreaText, sourceTitle } from './source-locator';

type Draft = Pick<KnowledgeCandidateDetail['revision'], 'title' | 'content' | 'reuseRationale'>;
type Evidence = Draft['content']['segments'][number]['evidence'][number];
interface BodyCitationEdit {
  segmentId: string; source: Evidence['source']; basis: Evidence['basis']; interpretation?: string;
  selection: { evidenceRef: string; quote: string; occurrence?: number };
}

/** Display-only locators; every saved source/version and position is checked again by the host. */
export function initialBodyCitations(detail: KnowledgeCandidateDetail): BodyCitationEdit[] {
  return detail.revision.content.segments.flatMap(segment => segment.evidence.map(evidence => {
    const source = detail.sources.find(value => value.status === 'available' && value.snapshot.snapshotId === evidence.source.snapshotId
      && value.snapshot.sourceVersion === evidence.source.sourceVersion);
    const excerpt = source?.status === 'available' ? source.snapshot.excerpts.find(value => value.evidenceRef === evidence.selection.evidenceRef) : undefined;
    let occurrence: number | undefined;
    if (excerpt) {
      const text = sourceTextAreaText(excerpt.text), quote = sourceTextAreaText(evidence.selection.quote);
      const start = sourceTextAreaOffset(excerpt.text, evidence.selection.start);
      let position = text.indexOf(quote), index = 0;
      while (position >= 0 && position < start) { position = text.indexOf(quote, position + 1); index++; }
      if (position === start) occurrence = index;
    }
    return { segmentId: segment.segmentId, source: evidence.source, basis: evidence.basis,
      ...(evidence.interpretation ? { interpretation: evidence.interpretation } : {}),
      selection: { evidenceRef: evidence.selection.evidenceRef, quote: evidence.selection.quote, ...(occurrence === undefined ? {} : { occurrence }) } };
  }));
}

export function resolveBodyCitations(draft: Draft, edits: BodyCitationEdit[], sources: KnowledgeCandidateDetail['sources']): { draft: Draft } | { error: string } {
  const result = structuredClone(draft);
  if (edits.some(edit => !result.content.segments.some(segment => segment.segmentId === edit.segmentId))) return { error: 'unknown_segment' };
  for (const segment of result.content.segments) {
    segment.evidence = [];
    for (const edit of edits.filter(value => value.segmentId === segment.segmentId)) {
      const source = sources.find(value => value.status === 'available' && value.snapshot.snapshotId === edit.source.snapshotId
        && value.snapshot.sourceVersion === edit.source.sourceVersion);
      if (!source || source.status !== 'available') return { error: 'source_unavailable' };
      const selection = locateSourceQuoteOccurrence(edit.selection, source.snapshot.excerpts);
      if (typeof selection === 'string') return { error: selection };
      segment.evidence.push({ source: { ...edit.source }, basis: edit.basis, selection,
        ...(edit.interpretation?.trim() ? { interpretation: edit.interpretation } : {}) });
    }
    if (!segment.evidence.length) return { error: 'missing_citation' };
  }
  return { draft: result };
}

export function BodyEvidenceEditor({ detail, draft, value, readOnly, lang, onChange }: {
  detail: KnowledgeCandidateDetail; draft: Draft; value: BodyCitationEdit[]; readOnly: boolean; lang: Language;
  onChange(value: BodyCitationEdit[]): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const choices = detail.sources.flatMap(source => source.status === 'available' ? source.snapshot.excerpts.map(excerpt => ({
    value: JSON.stringify([source.snapshot.snapshotId, source.snapshot.sourceVersion, excerpt.evidenceRef]),
    label: `${sourceTitle(source.snapshot, lang)} · ${sourceCoordinateLabel(excerpt.coordinate, lang)} · ${sourceMaterialLabel(excerpt.material.materialType, lang)} · ${excerpt.text.slice(0, 75)}`,
    source: { snapshotId: source.snapshot.snapshotId, sourceVersion: source.snapshot.sourceVersion }, snapshot: source.snapshot, excerpt,
  })) : []);
  const [inspected, setInspected] = useState(choices[0]?.value ?? '');
  const inspectedChoice = choices.find(choice => choice.value === inspected), excerpt = inspectedChoice?.excerpt;
  const originalLabel = inspectedChoice?.snapshot.sourceKind === 'agent_trace' ? t('原始消息（只读）', 'Original message (read-only)') : t('原始文件片段（只读）', 'Original file excerpt (read-only)');
  const locked = readOnly || !choices.length;
  const validation = resolveBodyCitations(draft, value, detail.sources);
  function update(index: number, edit: Partial<BodyCitationEdit>) { if (!locked) onChange(value.map((item, at) => at === index ? { ...item, ...edit } : item)); }
  return <section className="candidate-form" aria-label={t('正文来源与引文', 'Content sources and citations')}>
    <h3>{t('来源与引文', 'Sources and citations')}</h3>
    <p className="candidate-help">{t('每个知识段落保留直接依据。引文须逐字匹配；来源说法、推断与直接观测分别记录。', 'Keep direct evidence for each knowledge segment. Quotes must match exactly; distinguish source assertions, inference and direct observation.')}</p>
    {!choices.length && <Alert type="warning" title={t('来源不可读；已保存引文仍可复制，请重读来源后保存修订。', 'Sources are unavailable. Saved quotations remain copyable; reload the sources before saving.')}/>}
    {value.map((edit, index) => <section className="candidate-form candidate-statement" key={`${edit.segmentId}/${index}`}>
      <p>{t('知识段落', 'Knowledge segment')}：{draft.content.segments.find(segment => segment.segmentId === edit.segmentId)?.text.slice(0, 100)}</p>
      <label>{t(`引文 ${index + 1} 的来源片段`, `Source excerpt for citation ${index + 1}`)}<Select aria-label={t(`引文 ${index + 1} 的来源片段`, `Source excerpt for citation ${index + 1}`)} disabled={locked}
        value={JSON.stringify([edit.source.snapshotId, edit.source.sourceVersion, edit.selection.evidenceRef])} options={choices}
        onChange={key => { const choice = choices.find(item => item.value === key); if (!choice) return; setInspected(key); update(index, { source: choice.source, selection: { ...edit.selection, evidenceRef: choice.excerpt.evidenceRef, occurrence: undefined } }); }}/></label>
      <label>{t(`引文 ${index + 1}`, `Citation ${index + 1}`)}<Input.TextArea aria-label={t(`引文 ${index + 1}`, `Citation ${index + 1}`)} rows={3} readOnly={locked} value={edit.selection.quote}
        onFocus={() => setInspected(JSON.stringify([edit.source.snapshotId, edit.source.sourceVersion, edit.selection.evidenceRef]))}
        onChange={event => update(index, { selection: { ...edit.selection, quote: event.target.value } })}/></label>
      <label>{t('依据性质', 'Evidence basis')}<Select disabled={locked} value={edit.basis} options={[
        { value: 'source_assertion', label: t('来源中的说法', 'Source assertion') }, { value: 'direct_observation', label: t('直接观测', 'Direct observation') }, { value: 'inference', label: t('推断', 'Inference') },
      ]} onChange={basis => update(index, { basis })}/></label>
      <label>{t('依据说明', 'Evidence explanation')}<Input.TextArea readOnly={locked} rows={2} value={edit.interpretation ?? ''} onChange={event => update(index, { interpretation: event.target.value })}/></label>
      <details><summary>{t('相同引文出现多次时选择位置', 'Choose an occurrence for repeated quotations')}</summary>
        <label>{t('出现序号（从 0 开始）', 'Occurrence (starting at 0)')}<InputNumber min={0} max={Number.MAX_SAFE_INTEGER} precision={0} readOnly={locked} value={edit.selection.occurrence ?? null}
          onChange={occurrence => update(index, { selection: { ...edit.selection, occurrence: occurrence ?? undefined } })}/></label>
      </details>
      <Button danger disabled={locked} onClick={() => onChange(value.filter((_, position) => position !== index))}>{t(`移除引文 ${index + 1}`, `Remove citation ${index + 1}`)}</Button>
    </section>)}
    {draft.content.segments.map((segment, index) => <Button key={segment.segmentId} disabled={locked} onClick={() => {
      const choice = choices[0]; if (!choice) return;
      onChange([...value, { segmentId: segment.segmentId, source: choice.source, basis: 'source_assertion', selection: { evidenceRef: choice.excerpt.evidenceRef, quote: '' } }]);
    }}>{t(`为段落 ${index + 1} 添加引文`, `Add a citation to segment ${index + 1}`)}</Button>)}
    {'error' in validation && <Alert type="warning" title={t('引文尚未完整定位，请核对原文与出现位置后保存。', 'Citations are not fully located. Check the source and occurrence before saving.')}/>}
    {excerpt && inspectedChoice && <><SourceLocator source={inspectedChoice.snapshot} excerpt={excerpt} lang={lang}/><p className="candidate-help">{originalLabel}</p><Input.TextArea className="entity-source-text" aria-label={originalLabel} readOnly rows={8} value={excerpt.text}/></>}
  </section>;
}
