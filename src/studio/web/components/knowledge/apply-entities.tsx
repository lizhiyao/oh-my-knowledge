'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select, Spin } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateDetail, KnowledgeEntityAnalysisDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { EntityAnalysisContext } from './entity-analysis';

type Roles = { statementId: string; subjectId: string; objectId?: string }[];

export function ApplyEntitiesDialog({ detail, workspace, lang, onClose, onSaved }: {
  detail: KnowledgeCandidateDetail; workspace: string; lang: Language; onClose(): void; onSaved(value: KnowledgeCandidateDetail): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [analysis, setAnalysis] = useState<KnowledgeEntityAnalysisDetail>();
  const [roles, setRoles] = useState<Roles>(detail.revision.content.statements.map(statement => ({ statementId: statement.statementId,
    subjectId: statement.subject.entityId, ...(statement.object ? { objectId: statement.object.entityId } : {}) })));
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(true);
  const [uncertainties, setUncertainties] = useState(detail.grounding.identityUncertainties.join('\n'));
  const controller = useRef<AbortController | null>(null);
  async function api<T>(operation: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const response = await fetch('/api/knowledge/candidates', { method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, operation, ...fields }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error); return value as T;
  }
  async function load() {
    const active = new AbortController(); controller.current?.abort(); controller.current = active; setBusy(true); setError('');
    try {
      const value = await api<KnowledgeEntityAnalysisDetail>('entities', { analysisId: detail.grounding.entityAnalysisRef?.analysisId }, active.signal);
      if (!active.signal.aborted) {
        setAnalysis(value);
        const known = new Set(value.revision.entities.map(entity => entity.entityId));
        setRoles(current => current.map(role => ({ ...role, subjectId: known.has(role.subjectId) ? role.subjectId : '',
          ...(role.objectId && !known.has(role.objectId) ? { objectId: '' } : {}) })));
      }
    } catch { if (!active.signal.aborted) setError(t('无法读取实体修订。请先核对实体分析，再重新打开。', 'Could not load the entity revision. Inspect the analysis and reopen.')); }
    finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  useEffect(() => { void load(); return () => { controller.current?.abort(); controller.current = null; }; }, []);
  const known = new Set(analysis?.revision.entities.map(entity => entity.entityId));
  const complete = roles.every(role => known.has(role.subjectId) && (role.objectId === undefined || known.has(role.objectId)));
  async function save() {
    if (!analysis || controller.current || !complete) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setError('');
    const used = new Set(roles.flatMap(role => [role.subjectId, ...(role.objectId ? [role.objectId] : [])]));
    const draft = { title: detail.revision.title, evidence: detail.revision.evidence,
      entities: analysis.revision.entities.filter(entity => used.has(entity.entityId)).map(({ entityId, label, description }) => ({ entityId, label, description })),
      content: { ...detail.revision.content, statements: detail.revision.content.statements.map(statement => {
        const role = roles.find(role => role.statementId === statement.statementId)!;
        const rest = { ...statement }; delete rest.object;
        return { ...rest, subject: { entityId: role.subjectId }, ...(role.objectId ? { object: { entityId: role.objectId } } : {}) };
      }) },
    };
    try {
      const saved = await api<KnowledgeCandidateDetail>('apply-entities', { id: detail.revision.knowledgeId, revision: detail.revision.revisionId,
        generation: detail.history.generation, analysisId: analysis.history.analysisId, entityRevision: analysis.revision.revisionId, draft, reason: reason.trim(),
        identityUncertainties: uncertainties.split('\n').map(value => value.trim()).filter(Boolean) }, active.signal);
      if (!active.signal.aborted) onSaved(saved);
    } catch (cause) { if (!active.signal.aborted) setError(cause instanceof Error && cause.message === 'knowledge_conflict'
      ? t('知识已有更新，请关闭并重新读取后再应用。', 'Knowledge has changed. Close and reload before applying.')
      : t('应用未完成。请核对角色与来源；若保存确认丢失，先重新打开知识查看历史。', 'Could not apply. Check roles and sources. Reopen knowledge history first if the save acknowledgement was lost.')); }
    finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  return <Modal open centered className="entity-apply-modal" title={t('将实体修订应用到知识', 'Apply entity revision to knowledge')} width={720}
    onCancel={() => { controller.current?.abort(); onClose(); }} footer={<Button type="primary" loading={busy} disabled={!analysis || busy || !complete || !reason.trim() || analysis.source.status !== 'available'} onClick={() => void save()}>{t('核对并保存知识新修订', 'Review and save a new knowledge revision')}</Button>}>
    {error && <Alert type="error" title={error}/>} {busy && !analysis && <Spin/>}
    {analysis && <><EntityAnalysisContext detail={analysis} lang={lang}/>
      <EntityKnowledgeRoles detail={detail} analysis={analysis} roles={roles} disabled={busy} lang={lang} onChange={setRoles}/>
      <label className="entity-history-label">{t('核对附加的身份不确定性（每行一项）', 'Review additional identity uncertainties (one per line)')}<Input.TextArea value={uncertainties} disabled={busy} rows={3} onChange={event => setUncertainties(event.target.value)}/></label>
      <p className="candidate-help">{t('可删除有依据地解决的旧说明。当前实体分析仍有的不确定性会自动保留；陈述中的条件和未知信息另在知识修订中核对。', 'Remove prior notes only when evidence resolves them. Current entity uncertainties remain mandatory; inspect statement conditions and unknowns in the knowledge editor.')}</p>
      <label className="entity-history-label">{t('应用理由', 'Reason for applying')}<Input.TextArea value={reason} disabled={busy} rows={2} onChange={event => setReason(event.target.value)}/></label>
      <p className="candidate-help">{t('保存后绑定这里显示的实体修订；旧知识与旧决定仍在历史中，新知识修订需要重新决定保留或舍弃。', 'Saving binds the entity revision shown here. Old knowledge and decisions remain in history; make a new retention decision for the new knowledge revision.')}</p>
    </>}
  </Modal>;
}

export function EntityKnowledgeRoles({ detail, analysis, roles, disabled, lang, onChange }: {
  detail: { revision: Pick<KnowledgeCandidateDetail['revision'], 'content'> }; analysis: KnowledgeEntityAnalysisDetail; roles: Roles; disabled: boolean; lang: Language; onChange(value: Roles): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const options = analysis.revision.entities.map(entity => ({ value: entity.entityId, label: `${entity.label} · ${entity.qualifiers.join(' / ') || entity.description.slice(0, 48)} · ${entity.entityId.slice(-8)}` }));
  function update(index: number, patch: Partial<Roles[number]>) { onChange(roles.map((role, position) => position === index ? { ...role, ...patch } : role)); }
  return <div className="candidate-form"><p>{t('逐条核对主体与对象。被删除或拆分的旧身份须明确重新选择，系统不会替你任选一个。', 'Check each subject and object. Explicitly reselect removed or split identities; the system will not choose a replacement.')}</p>
    {detail.revision.content.statements.map((statement, index) => <section className="candidate-form candidate-statement" key={statement.statementId}>
      <p>{statement.relation}</p>
      <label>{t('主体', 'Subject')}<Select disabled={disabled} value={roles[index].subjectId || undefined} options={options} placeholder={t('明确选择主体', 'Choose the subject explicitly')} onChange={subjectId => update(index, { subjectId })}/></label>
      <label>{t('对象（可以没有）', 'Object (optional)')}<Select disabled={disabled} value={roles[index].objectId} options={options} allowClear placeholder={t('明确选择对象或保持无对象', 'Choose an object or keep it absent')} onChange={objectId => update(index, { objectId })}/></label>
      {roles[index].objectId === '' && <Alert type="warning" title={t('原对象已被移除。请选择新对象，或明确清除此陈述的对象。', 'The previous object was removed. Choose a replacement or explicitly clear the object.')}/>}
    </section>)}
  </div>;
}
