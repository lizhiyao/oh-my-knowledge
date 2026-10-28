'use client';
import { useState } from 'react';
import { Button, Drawer, Input } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { BodyEvidenceEditor, initialBodyCitations, resolveBodyCitations } from './body-evidence-editor';
import { RevisionSaveFeedback, useRevisionSave } from './revision-save';

type Draft = Pick<KnowledgeCandidateDetail['revision'], 'title' | 'content' | 'reuseRationale'>;

export function KnowledgeRevisionDrawer({ detail: initialDetail, workspace, lang, onClose, onSaved, onReadback }: {
  detail: KnowledgeCandidateDetail; workspace: string; lang: Language; onClose(needsReadback: boolean): void;
  onSaved(value: KnowledgeCandidateDetail): void; onReadback(value: KnowledgeCandidateDetail): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  // Background refresh never changes this editor's explicit write baseline.
  const [detail] = useState(initialDetail);
  const [draft, setDraft] = useState<Draft>(() => structuredClone({ title: detail.revision.title, content: detail.revision.content, reuseRationale: detail.revision.reuseRationale }));
  const [reason, setReason] = useState('');
  const [citations, setCitations] = useState(() => initialBodyCitations(detail));
  const save = useRevisionSave(workspace, detail, lang);
  const resolved = resolveBodyCitations(draft, citations, detail.sources);
  function update(edit: (value: Draft) => void) { if (save.locked) return; const next = structuredClone(draft); edit(next); setDraft(next); }
  async function submit() {
    if ('error' in resolved) return;
    const saved = await save.save('revise', { id: detail.revision.knowledgeId, revision: detail.revision.revisionId,
      generation: detail.history.generation, draft: resolved.draft, reason: reason.trim() });
    if (saved?.current()) onSaved(saved.value);
  }
  return <Drawer title={t('修订知识正文', 'Edit knowledge content')} open closable={!save.busy} keyboard={!save.busy} maskClosable={!save.busy} onClose={() => !save.busy && onClose(save.recovery)} size={680}
    extra={<Button type="primary" loading={save.busy} disabled={save.locked || !reason.trim() || 'error' in resolved} onClick={() => void submit()}>{t('保存新修订', 'Save new revision')}</Button>}>
    <RevisionSaveFeedback save={save} lang={lang} onOpenLatest={onReadback}/>
    <p>{t('完整保留正文的条件、否定、归因和未知。保存产生新修订，原保留或舍弃决定不会带过来；派生关联需针对新正文重新核对。', 'Preserve conditions, negation, attribution and unknowns. Saving creates a new revision without inheriting retention decisions; derived associations must be reviewed for the new content.')}</p>
    <label className="entity-history-label">{t('修订理由', 'Revision reason')}<Input aria-label={t('修订理由', 'Revision reason')} readOnly={save.locked} value={reason} onChange={event => { if (!save.locked) setReason(event.target.value); }}/></label>
    <div className="candidate-form">
      <label>{t('标题', 'Title')}<Input aria-label={t('标题', 'Title')} readOnly={save.locked} value={draft.title} onChange={event => update(next => { next.title = event.target.value; })}/></label>
      {draft.content.segments.map((segment, index) => <section key={segment.segmentId} className="candidate-form candidate-statement">
        <label>{t(`知识段落 ${index + 1}`, `Knowledge segment ${index + 1}`)}<Input.TextArea aria-label={t(`知识段落 ${index + 1}`, `Knowledge segment ${index + 1}`)} readOnly={save.locked} value={segment.text} rows={6}
          onChange={event => update(next => { next.content.segments[index].text = event.target.value; })}/></label>
      </section>)}
      <label>{t('复用说明', 'Reuse notes')}<Input.TextArea readOnly={save.locked} rows={3} value={draft.reuseRationale} onChange={event => update(next => { next.reuseRationale = event.target.value; })}/></label>
      <BodyEvidenceEditor detail={detail} draft={draft} value={citations} readOnly={save.locked} lang={lang} onChange={setCitations}/>
    </div>
  </Drawer>;
}
