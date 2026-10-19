'use client';
import { useState } from 'react';
import { Button, Drawer, Input, Select } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { CitationLocatorEditor, initialCitationLocators } from './citation-editor';
import { RevisionSaveFeedback, useRevisionSave } from './revision-save';

type Draft = Pick<KnowledgeCandidateDetail['revision'], 'title' | 'content' | 'entities' | 'evidence'>;

export function KnowledgeRevisionDrawer({ detail: initialDetail, workspace, lang, onClose, onSaved, onReadback }: {
  detail: KnowledgeCandidateDetail; workspace: string; lang: Language; onClose(needsReadback: boolean): void;
  onSaved(value: KnowledgeCandidateDetail): void; onReadback(value: KnowledgeCandidateDetail): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  // A background refresh must not advance the open editor's write baseline.
  const [detail] = useState(initialDetail);
  const [draft, setDraft] = useState<Draft>(() => structuredClone({ title: detail.revision.title, content: detail.revision.content, entities: detail.revision.entities, evidence: detail.revision.evidence }));
  const [reason, setReason] = useState('');
  const [locators, setLocators] = useState(() => initialCitationLocators(detail));
  const [citationsChanged, setCitationsChanged] = useState(false);
  const save = useRevisionSave(workspace, detail, lang);
  function update(edit: (value: Draft) => void) { if (save.locked) return; const value = structuredClone(draft); edit(value); setDraft(value); }
  async function submit() {
    const saved = await save.save('revise', { id: detail.revision.knowledgeId, revision: detail.revision.revisionId, generation: detail.history.generation,
      draft, reason: reason.trim(), ...(citationsChanged ? { citationLocators: locators } : {}) });
    if (saved?.current()) onSaved(saved.value);
  }
  return <Drawer title={t('修订知识内容', 'Edit knowledge content')} open closable={!save.busy} keyboard={!save.busy} maskClosable={!save.busy} onClose={() => !save.busy && onClose(save.recovery)} size={680}
    extra={<Button type="primary" loading={save.busy} disabled={save.locked || !reason.trim() || (citationsChanged && !locators.length)} onClick={() => void submit()}>{t('保存新修订', 'Save new revision')}</Button>}>
    <RevisionSaveFeedback save={save} lang={lang} onOpenLatest={onReadback}/>
    <p>{t('修改标题、陈述、上下文与精确引文。来源窗口及实体身份保持绑定；保存后是一条新修订，原先的保留或舍弃决定不会带过来。', 'Edit the title, statements, context and exact citations. The source window and entity identities remain bound. Saving creates a new revision; the previous retain or discard decision does not carry over.')}</p>
    <label className="entity-history-label">{t('修订理由', 'Revision reason')}<Input aria-label={t('修订理由', 'Revision reason')} readOnly={save.locked} value={reason} onChange={event => { if (!save.locked) setReason(event.target.value); }}/></label>
    <div className="candidate-form">
      <label>{t('标题', 'Title')}<Input aria-label={t('标题', 'Title')} readOnly={save.locked} value={draft.title} onChange={event => update(value => { value.title = event.target.value; })}/></label>
      {detail.grounding.entityAnalysisRef && <p>{t('实体名称来自已绑定的分析。需要改名称或对应时，先核对实体，再应用实体修订。', 'Entity names come from the bound analysis. Inspect entities and apply an entity revision to change names or assignments.')}</p>}
      {draft.entities.map((entity, index) => <label key={entity.entityId}>{t('实体名称', 'Entity name')}<Input readOnly={save.locked || !!detail.grounding.entityAnalysisRef} value={entity.label} onChange={event => update(value => { value.entities[index].label = event.target.value; })}/></label>)}
      {draft.evidence.map((link, index) => <label key={link.evidenceLinkId}>{t('证据解释', 'Evidence interpretation')}<Input.TextArea readOnly={save.locked} value={link.interpretation} rows={2} onChange={event => update(value => { value.evidence[index].interpretation = event.target.value; })}/></label>)}
      {draft.content.statements.map((statement, index) => <section key={statement.statementId} className="candidate-form candidate-statement">
        <label>{t('陈述', 'Statement')}<Input.TextArea readOnly={save.locked} value={statement.relation} rows={3} onChange={event => update(value => { value.content.statements[index].relation = event.target.value; })}/></label>
        <label>{t('肯定／否定', 'Polarity')}<Select disabled={save.locked} value={statement.polarity} options={[{ value: 'positive', label: t('肯定', 'Positive') }, { value: 'negative', label: t('否定', 'Negative') }]} onChange={polarity => update(value => { value.content.statements[index].polarity = polarity; })}/></label>
        <label>{t('陈述含义', 'Modality')}<Select disabled={save.locked} value={statement.modality} options={[{ value: 'descriptive', label: t('描述', 'Description') }, { value: 'normative', label: t('规范要求', 'Normative requirement') }, { value: 'capability', label: t('能力', 'Capability') }, { value: 'permission', label: t('许可', 'Permission') }]} onChange={modality => update(value => { value.content.statements[index].modality = modality; })}/></label>
        <label>{t('适用场景', 'Scenario')}<Input.TextArea readOnly={save.locked} value={statement.context.scenario} rows={2} onChange={event => update(value => { value.content.statements[index].context.scenario = event.target.value; })}/></label>
        {(['conditions', 'exceptions', 'unknowns'] as const).map(field => <label key={field}>{field === 'conditions' ? t('条件（每行一项）', 'Conditions (one per line)') : field === 'exceptions' ? t('例外（每行一项）', 'Exceptions (one per line)') : t('未知信息（每行一项）', 'Unknowns (one per line)')}<Input.TextArea readOnly={save.locked} value={statement.context[field].join('\n')} rows={2} onChange={event => update(value => { value.content.statements[index].context[field] = event.target.value.split('\n').filter(line => line.trim()); })}/></label>)}
      </section>)}
      <CitationLocatorEditor detail={detail} evidence={draft.evidence} value={locators} readOnly={save.locked} lang={lang} onChange={(value, evidence) => {
        setLocators(value); setCitationsChanged(true); setDraft(current => ({ ...current, evidence }));
      }}/>
    </div>
  </Drawer>;
}
