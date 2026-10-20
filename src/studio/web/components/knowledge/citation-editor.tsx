'use client';
import { useState } from 'react';
import { Alert, Button, Input, InputNumber, Select } from 'antd';
import type { KnowledgeCitationLocator } from '../../../../knowledge/application/citation-locators';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { Language } from '../layout/shell';

type Evidence = KnowledgeCandidateDetail['revision']['evidence'];

/** Convert saved positions for display only; the host resolves and validates every edited locator. */
export function initialCitationLocators(detail: KnowledgeCandidateDetail): KnowledgeCitationLocator[] {
  return detail.grounding.citations.map(({ evidenceLinkId, selection }) => {
    const sources = detail.sources.flatMap(source => source.status === 'available' ? source.window.excerpts : [])
      .filter(excerpt => excerpt.evidenceRef === selection.evidenceRef);
    let occurrence: number | undefined;
    if (sources.length === 1 && selection.quote) {
      const text = sources[0].text;
      let start = text.indexOf(selection.quote), index = 0;
      while (start >= 0 && start < selection.start) { start = text.indexOf(selection.quote, start + 1); index++; }
      if (start === selection.start) occurrence = index;
    }
    return { evidenceLinkId, selection: { evidenceRef: selection.evidenceRef, quote: selection.quote,
      ...(occurrence === undefined ? {} : { occurrence }) } };
  });
}

export function CitationLocatorEditor({ detail, evidence, value, readOnly, lang, onChange }: {
  detail: KnowledgeCandidateDetail; evidence: Evidence; value: KnowledgeCitationLocator[]; readOnly: boolean; lang: Language;
  onChange(value: KnowledgeCitationLocator[], evidence: Evidence): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const sources = detail.sources.flatMap(source => source.status === 'available' ? source.window.excerpts : []);
  const [inspected, setInspected] = useState(value[0]?.selection.evidenceRef ?? sources[0]?.evidenceRef ?? '');
  const excerpt = sources.find(source => source.evidenceRef === inspected);
  const locked = readOnly || !sources.length;
  function update(index: number, patch: Partial<KnowledgeCitationLocator['selection']>) {
    if (locked) return;
    const selected = value[index];
    // One evidence link refers to one message; preserve every quote for explicit user review.
    const next = value.map((locator, position) => ({ ...locator, selection: { ...locator.selection,
      ...(position === index ? patch : {}),
      ...(patch.evidenceRef !== undefined && locator.evidenceLinkId === selected.evidenceLinkId ? { evidenceRef: patch.evidenceRef } : {}) } }));
    if (patch.evidenceRef !== undefined) setInspected(patch.evidenceRef);
    onChange(next, patch.evidenceRef === undefined ? evidence : evidence.map(link => link.evidenceLinkId === selected.evidenceLinkId ? { ...link, evidenceRef: patch.evidenceRef! } : link));
  }
  return <section className="candidate-form" aria-label={t('修订精确引文', 'Edit exact citations')}>
    <h3>{t('引文与原始消息', 'Citations and original messages')}</h3>
    <p className="candidate-help">{t('核对原文后保存完整引文列表；删除只影响新修订。同一证据关联更换消息时，其所有引文一起更换消息，原文仍须逐条核对。', 'Review the source and save the complete citation list. Removal affects only the new revision. Changing a message updates every citation for that evidence link; review each quotation explicitly.')}</p>
    <details><summary>{t('已保存的引文', 'Saved citations')}</summary>{detail.grounding.citations.map((citation, index) => <div key={index}>
      <p className="candidate-help">{citation.evidenceLinkId} · {citation.selection.evidenceRef}</p><blockquote>{citation.selection.quote}</blockquote>
    </div>)}</details>
    {!sources.length && <Alert type="warning" title={t('绑定的来源不可读，不能修改引文。已保存引文仍可复制；请先重新读取来源。', 'The bound source is unavailable, so citations cannot be edited. Saved quotations remain copyable; reload the source first.')}/>}
    {value.map((locator, index) => <section className="candidate-form candidate-statement" key={index}>
      <label>{t(`引文 ${index + 1} 的证据关联`, `Evidence link for citation ${index + 1}`)}<Select aria-label={t(`引文 ${index + 1} 的证据关联`, `Evidence link for citation ${index + 1}`)} disabled={locked}
        value={locator.evidenceLinkId} options={evidence.map(link => ({ value: link.evidenceLinkId, label: `${link.interpretation} · ${link.evidenceLinkId}` }))}
        onChange={evidenceLinkId => { const link = evidence.find(link => link.evidenceLinkId === evidenceLinkId); if (!link) return;
          onChange(value.map((item, position) => position === index ? { ...item, evidenceLinkId, selection: { ...item.selection, evidenceRef: link.evidenceRef } } : item), evidence); setInspected(link.evidenceRef); }}/></label>
      <label>{t(`引文 ${index + 1} 的来源消息`, `Source message for citation ${index + 1}`)}<Select aria-label={t(`引文 ${index + 1} 的来源消息`, `Source message for citation ${index + 1}`)} disabled={locked}
        value={locator.selection.evidenceRef} options={sources.map(source => ({ value: source.evidenceRef, label: `${source.recordIndex} · ${source.role ?? source.eventKind} · ${source.text.slice(0, 90)}` }))}
        onFocus={() => setInspected(locator.selection.evidenceRef)} onChange={evidenceRef => update(index, { evidenceRef })}/></label>
      <label>{t(`引文 ${index + 1} 的原文`, `Quotation for citation ${index + 1}`)}<Input.TextArea aria-label={t(`引文 ${index + 1} 的原文`, `Quotation for citation ${index + 1}`)} rows={3}
        readOnly={locked} value={locator.selection.quote} onFocus={() => setInspected(locator.selection.evidenceRef)} onChange={event => update(index, { quote: event.target.value })}/></label>
      <label>{t(`引文 ${index + 1} 的出现序号（从零开始，可留空）`, `Occurrence for citation ${index + 1} (zero-based, optional)`)}<InputNumber aria-label={t(`引文 ${index + 1} 的出现序号（从零开始，可留空）`, `Occurrence for citation ${index + 1} (zero-based, optional)`)}
        min={0} max={Number.MAX_SAFE_INTEGER} precision={0} readOnly={locked} value={locator.selection.occurrence ?? null} onChange={occurrence => update(index, { occurrence: occurrence ?? undefined })}/></label>
      <Button danger disabled={locked} onClick={() => onChange(value.filter((_, position) => position !== index), evidence)}>{t(`移除引文 ${index + 1}`, `Remove citation ${index + 1}`)}</Button>
    </section>)}
    {!value.length && <Alert type="warning" title={t('至少保留一条引文，并覆盖每个证据关联。', 'Keep at least one citation and cover every evidence link.')}/>}
    <Button disabled={locked || value.length >= 512 || !evidence.length} onClick={() => { const link = evidence[0]; onChange([...value, { evidenceLinkId: link.evidenceLinkId, selection: { evidenceRef: link.evidenceRef, quote: '' } }], evidence); }}>{t('添加引文', 'Add citation')}</Button>
    <p className="candidate-help">{t('原文必须逐字匹配，空格与换行也保留。相同原文多次出现时必须填写序号：第一次为 0，第二次为 1；重叠出现也计数。唯一出现时可留空。', 'Quotations must match exactly, including whitespace and line breaks. Repeated quotations require an occurrence: 0 for the first, 1 for the second; overlapping occurrences also count. Leave it blank only for a unique occurrence.')}</p>
    {excerpt && <><p className="candidate-help">{t('原始消息（只读）：', 'Original message (read-only): ')}{excerpt.recordIndex} · {excerpt.role ?? excerpt.eventKind} · {excerpt.evidenceRef}</p>
      <Input.TextArea className="entity-source-text" aria-label={t('原始消息（只读）', 'Original message (read-only)')} value={excerpt.text} readOnly rows={8}/></>}
  </section>;
}
