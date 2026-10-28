'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Input, Select, Space } from 'antd';
import type { KnowledgeCandidateDetail, KnowledgeEntityAnalysisDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { Language } from '../layout/shell';
import { requestKnowledge } from './request';
import { RevisionSaveFeedback, useRevisionSave } from './revision-save';

type Mapping = NonNullable<KnowledgeCandidateDetail['derivedAssociations']['revision']>['segmentEntityRefs'];

/** Explicit entity/mention choices only; body and projection CAS baselines stay fixed for this editor. */
export function AssociationMappingDrawer({ detail: initialDetail, workspace, lang, onClose, onSaved, onReadback }: {
  detail: KnowledgeCandidateDetail; workspace: string; lang: Language; onClose(needsReadback: boolean): void;
  onSaved(value: KnowledgeCandidateDetail): void; onReadback(value: KnowledgeCandidateDetail): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [detail] = useState(initialDetail);
  const bound = detail.derivedAssociations.revision?.entityAnalysisRef;
  const [analysisId, setAnalysisId] = useState(bound?.analysisId ?? '');
  const [catalog, setCatalog] = useState<KnowledgeEntityAnalysisDetail>();
  const [mappings, setMappings] = useState<Mapping>([]);
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false), [readError, setReadError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const save = useRevisionSave(workspace, detail, lang);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
  const locked = save.locked || reading;
  const busy = save.busy || reading;
  async function load(revision?: string) {
    if (locked || controller.current || !analysisId.trim()) return;
    const active = new AbortController(); controller.current = active; setReading(true); setReadError('');
    try {
      const next = await requestKnowledge<KnowledgeEntityAnalysisDetail>('candidates', { workspace, operation: 'entities', analysisId: analysisId.trim(), ...(revision ? { revision } : {}) }, active.signal);
      if (active.signal.aborted) return;
      setCatalog(next); setConfirmed(false);
      // Restore only the already-declared mappings of the exact bound revision; never infer a replacement.
      setMappings(bound?.analysisId === next.history.analysisId && bound.revisionId === next.revision.revisionId
        && detail.derivedAssociations.status === 'available' ? structuredClone(detail.derivedAssociations.revision?.segmentEntityRefs ?? []) : []);
    } catch { if (!active.signal.aborted) setReadError(t('实体修订暂不可读，映射草稿未保存。可重新读取。', 'Entity revision unavailable. The mapping draft was not saved. Retry loading.')); }
    finally { if (controller.current === active) { controller.current = null; setReading(false); } }
  }
  const selectedCatalog = catalog && catalog.history.analysisId === analysisId.trim() ? catalog : undefined;
  const invalid = !selectedCatalog || selectedCatalog.source.status !== 'available' || mappings.some(ref =>
    !selectedCatalog.revision.entities.some(entity => entity.entityId === ref.entityId) || !ref.mentionIds.length
    || ref.mentionIds.some(id => !selectedCatalog.revision.mentions.some(mention => mention.mentionId === id && mention.entityId === ref.entityId)));
  function chooseEntities(segmentId: string, entityIds: string[]) {
    if (locked) return;
    setMappings([...mappings.filter(ref => ref.segmentId !== segmentId), ...entityIds.map(entityId =>
      mappings.find(ref => ref.segmentId === segmentId && ref.entityId === entityId) ?? { segmentId, entityId, mentionIds: [] })]);
  }
  async function submit() {
    if (!selectedCatalog || invalid || !confirmed || !reason.trim() || locked) return;
    const result = await save.save('apply-associations', { id: detail.revision.knowledgeId, revision: detail.revision.revisionId,
      bodyDigest: detail.revision.bodyDigest, generation: detail.derivedAssociations.generation,
      analysisId: selectedCatalog.history.analysisId, entityRevision: selectedCatalog.revision.revisionId,
      draft: { segmentEntityRefs: mappings, issues: [] }, reason: reason.trim() });
    if (result?.current()) onSaved(result.value);
  }
  return <Drawer open title={t('编辑实体映射', 'Edit entity mappings')} size={680} closable={!busy} keyboard={!busy} maskClosable={!busy}
    onClose={() => !busy && onClose(save.recovery)} extra={<Button type="primary" loading={save.busy} disabled={locked || invalid || !confirmed || !reason.trim()} onClick={() => void submit()}>{t('保存待核对映射', 'Save pending mappings')}</Button>}>
    <RevisionSaveFeedback save={save} lang={lang} onOpenLatest={onReadback}/>
    {readError && <Alert type="error" title={readError}/>}
    <p>{t('只修改派生实体映射；正文、正文摘要及保留决定保持原样。新映射需要单独核对。', 'Edit derived entity mappings only. Content, its digest and retention decision remain unchanged. New mappings require independent review.')}</p>
    <div className="candidate-form">
      <label>{t('实体分析 ID', 'Entity analysis ID')}<Input aria-label={t('实体分析 ID', 'Entity analysis ID')} value={analysisId} readOnly={locked} onChange={event => { setAnalysisId(event.target.value); setConfirmed(false); }}/></label>
      <Space wrap><Button disabled={locked || !analysisId.trim()} loading={reading} onClick={() => void load()}>{t('载入当前实体修订', 'Load current entity revision')}</Button>
        {bound && <Button disabled={locked || analysisId.trim() !== bound.analysisId} onClick={() => void load(bound.revisionId)}>{t('载入原绑定修订', 'Load bound revision')}</Button>}</Space>
      {selectedCatalog && <>
        <label>{t('明确选择实体修订', 'Select exact entity revision')}<Select aria-label={t('明确选择实体修订', 'Select exact entity revision')} disabled={locked} value={selectedCatalog.revision.revisionId}
          options={selectedCatalog.history.revisions.map(revision => ({ value: revision.revisionId, label: `${revision.revisionId} · ${revision.revisionReason}` }))} onChange={revision => void load(revision)}/></label>
        <p className="candidate-help">{t('已载入：', 'Loaded: ')}<code>{selectedCatalog.revision.revisionId}</code> · {selectedCatalog.revision.revisionId === selectedCatalog.history.writeHeadRevisionId ? t('当前修订', 'Current revision') : t('历史修订', 'Historical revision')}</p>
        <p>{t('切换修订后重新明确选择；不会自动选取剩余对象或提及。未映射的段落仍保留正文。', 'Choose mappings explicitly after switching revisions. No remaining entities or mentions are automatically selected. Unmapped segments retain their content.')}</p>
        {selectedCatalog.source.status !== 'available' && <Alert type="warning" title={t('实体来源不可用，不能保存新映射。', 'Entity source unavailable; new mappings cannot be saved.')}/>}
        {detail.revision.content.segments.map((segment, index) => <section className="candidate-form candidate-statement" key={segment.segmentId}>
          <p>{segment.text}</p>
          <label>{t(`段落 ${index + 1} 的对象`, `Entities for segment ${index + 1}`)}<Select mode="multiple" aria-label={t(`段落 ${index + 1} 的对象`, `Entities for segment ${index + 1}`)} disabled={locked} value={mappings.filter(ref => ref.segmentId === segment.segmentId).map(ref => ref.entityId)}
            options={selectedCatalog.revision.entities.map(entity => ({ value: entity.entityId, label: `${entity.label} · ${entity.description}` }))} onChange={ids => chooseEntities(segment.segmentId, ids)}/></label>
          {mappings.filter(ref => ref.segmentId === segment.segmentId).map(ref => <fieldset disabled={locked} key={ref.entityId}>
            <legend>{t('明确选择提及：', 'Select mentions: ')}{selectedCatalog.revision.entities.find(entity => entity.entityId === ref.entityId)?.label}</legend>
            <Checkbox.Group<string> aria-label={`${t('段落', 'Segment')} ${index + 1} / ${ref.entityId}`} value={ref.mentionIds} options={selectedCatalog.revision.mentions.filter(mention => mention.entityId === ref.entityId)
              .map(mention => ({ value: mention.mentionId, label: <span>{mention.selection.quote} <span className="candidate-help">({mention.selection.evidenceRef} · {mention.selection.start}–{mention.selection.end})</span></span> }))}
              onChange={ids => { if (!locked) setMappings(mappings.map(item => item === ref ? { ...item, mentionIds: ids } : item)); }}/>
          </fieldset>)}
        </section>)}
      </>}
      <label>{t('映射修改理由', 'Mapping reason')}<Input.TextArea aria-label={t('映射修改理由', 'Mapping reason')} readOnly={locked} value={reason} onChange={event => setReason(event.target.value)}/></label>
      <Checkbox disabled={locked || !selectedCatalog} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}>{t('本次只保存实体映射，不编辑或沿用已有 typedRelations；它们的原件留在关联历史，新修订不含这些关系。我已核对上述精确实体修订与选择。', 'Save entity mappings only. Existing typedRelations are not edited or inherited; their originals remain in association history and are absent from the new revision. I checked the exact entity revision and selections above.')}</Checkbox>
    </div>
  </Drawer>;
}
