'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Input, Select, Space } from 'antd';
import type { KnowledgeAssociationCatalogs, KnowledgeCandidateDetail, KnowledgeEntityAnalysisDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { Language } from '../layout/shell';
import { requestKnowledge } from './request';
import { RevisionSaveFeedback, useRevisionSave } from './revision-save';
import { displayTime } from '../../../application/display/format';

type Mapping = NonNullable<KnowledgeCandidateDetail['derivedAssociations']['revision']>['segmentEntityRefs'];

/** Explicit entity/mention choices only; body and projection CAS baselines stay fixed for this editor. */
export function AssociationMappingDrawer({ detail: initialDetail, workspace, lang, initialAnalysisId, initialRevision, onClose, onSaved, onReadback }: {
  detail: KnowledgeCandidateDetail; workspace: string; lang: Language; onClose(needsReadback: boolean): void;
  initialAnalysisId?: string; initialRevision?: string;
  onSaved(value: KnowledgeCandidateDetail): void; onReadback(value: KnowledgeCandidateDetail): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [detail] = useState(initialDetail);
  const bound = detail.derivedAssociations.revision?.entityAnalysisRef;
  const [analysisId, setAnalysisId] = useState(initialAnalysisId ?? bound?.analysisId ?? '');
  const [catalogs, setCatalogs] = useState<KnowledgeAssociationCatalogs>();
  const [catalogsReading, setCatalogsReading] = useState(true), [catalogsError, setCatalogsError] = useState('');
  const [catalog, setCatalog] = useState<KnowledgeEntityAnalysisDetail>();
  const [mappings, setMappings] = useState<Mapping>([]);
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false), [readError, setReadError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const catalogsController = useRef<AbortController | null>(null);
  const drafts = useRef(new Map<string, Mapping>());
  const initialLoaded = useRef(false);
  const save = useRevisionSave(workspace, detail, lang);
  useEffect(() => { void loadCatalogs(); return () => { controller.current?.abort(); controller.current = null; catalogsController.current?.abort(); catalogsController.current = null; }; }, []);
  const locked = save.locked || reading;
  const busy = save.busy || reading;
  async function loadCatalogs() {
    if (catalogsController.current) return;
    const active = new AbortController(); catalogsController.current = active; setCatalogsReading(true); setCatalogsError('');
    try {
      const next = await requestKnowledge<KnowledgeAssociationCatalogs>('candidates', { workspace, operation: 'association-catalogs', id: detail.revision.knowledgeId, revision: detail.revision.revisionId }, active.signal);
      if (active.signal.aborted) return;
      setCatalogs(next);
      if (!initialLoaded.current && initialAnalysisId && next.catalogs.some(item => item.analysisId === initialAnalysisId)) {
        initialLoaded.current = true;
        void load(initialRevision, initialAnalysisId);
      }
    } catch { if (!active.signal.aborted) setCatalogsError(t('匹配来源的实体分析目录暂不可读，不能据此判断没有分析。映射草稿仍保留。', 'Matching entity analyses could not be read. This does not establish that none exist. Your mapping draft is preserved.')); }
    finally { if (catalogsController.current === active) { catalogsController.current = null; setCatalogsReading(false); } }
  }
  async function load(revision?: string, requestedAnalysis = analysisId) {
    if (locked || controller.current || !requestedAnalysis) return;
    const active = new AbortController(); controller.current = active; setReading(true); setReadError('');
    try {
      const next = await requestKnowledge<KnowledgeEntityAnalysisDetail>('candidates', { workspace, operation: 'entities', analysisId: requestedAnalysis, ...(revision ? { revision } : {}) }, active.signal);
      if (active.signal.aborted) return;
      if (catalog) drafts.current.set(`${catalog.history.analysisId}/${catalog.revision.revisionId}`, structuredClone(mappings));
      setCatalog(next); setAnalysisId(next.history.analysisId); setConfirmed(false);
      // Restore only the already-declared mappings of the exact bound revision; never infer a replacement.
      setMappings(drafts.current.get(`${next.history.analysisId}/${next.revision.revisionId}`) ?? (bound?.analysisId === next.history.analysisId && bound.revisionId === next.revision.revisionId
        && detail.derivedAssociations.status === 'available' ? structuredClone(detail.derivedAssociations.revision?.segmentEntityRefs ?? []) : []));
    } catch { if (!active.signal.aborted) setReadError(t('实体修订暂不可读，已有映射草稿仍保留。可重新读取。', 'Entity revision unavailable. Your existing mapping draft is preserved. Retry loading.')); }
    finally { if (controller.current === active) { controller.current = null; setReading(false); } }
  }
  const selectedCatalog = catalog;
  const analysisOptions = catalogs?.catalogs.map((item, index) => {
    const current = item.revisions.find(revision => revision.revisionId === item.writeHeadRevisionId), source = item.sourceSummary;
    return { value: item.analysisId, label: [source?.title || t(`来源分析 ${index + 1}（未记录标题）`, `Source analysis ${index + 1} (untitled)`),
      ...(source ? [`${source.sourceKind} · ${t(`${source.excerptCount} 条来源消息`, `${source.excerptCount} source messages`)}`] : []),
      ...(current ? [t(`${current.entityCount} 个对象`, `${current.entityCount} ${current.entityCount === 1 ? 'entity' : 'entities'}`), displayTime(current.revisedAt)] : [])].join(' · ') };
  });
  const eligible = catalogs?.catalogs.some(item => item.analysisId === selectedCatalog?.history.analysisId);
  const unavailableSources = catalogs?.sources.filter(source => source.status !== 'available').length ?? 0;
  const unanalysedSources = catalogs?.sources.filter(source => source.status === 'available'
    && !catalogs.catalogs.some(item => item.snapshotId === source.snapshotId && item.sourceVersion === source.sourceVersion)).length ?? 0;
  const invalid = !selectedCatalog || selectedCatalog.history.analysisId !== analysisId || !eligible || catalogsReading || !!catalogsError || selectedCatalog.source.status !== 'available' || mappings.some(ref =>
    !selectedCatalog.revision.entities.some(entity => entity.entityId === ref.entityId) || !ref.mentionIds.length
    || ref.mentionIds.some(id => !selectedCatalog.revision.mentions.some(mention => mention.mentionId === id && mention.entityId === ref.entityId)));
  function chooseEntities(segmentId: string, entityIds: string[]) {
    if (locked) return;
    setConfirmed(false);
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
    {catalogsError && <Alert type="error" title={catalogsError} action={<Button disabled={catalogsReading || save.locked} onClick={() => void loadCatalogs()}>{t('重新读取分析目录', 'Reload analysis catalog')}</Button>}/>}
    {readError && <Alert type="error" title={readError}/>}
    <p>{t('只修改派生实体映射；正文、正文摘要及保留决定保持原样。新映射需要单独核对。', 'Edit derived entity mappings only. Content, its digest and retention decision remain unchanged. New mappings require independent review.')}</p>
    <details><summary>{t('本次编辑的知识与关联基线', 'Knowledge and association baseline for this edit')}</summary>
      <p className="candidate-help">{t('知识修订：', 'Knowledge revision: ')}<code>{detail.revision.revisionId}</code> · {t('关联基线：', 'Association baseline: ')}<code>{detail.derivedAssociations.headRevisionId ?? t('尚无关联', 'No association')}</code></p>
    </details>
    {!!catalogs?.unavailableAnalyses && <Alert type="warning" title={t(`${catalogs.unavailableAnalyses} 份分析不可读，目录覆盖不全。`, `${catalogs.unavailableAnalyses} analyses are unreadable; catalog coverage is incomplete.`)}/>}
    {!!unavailableSources && <Alert type="warning" title={t(`${unavailableSources} 份来源不可用，无法完整核对。`, `${unavailableSources} sources are unavailable; evidence cannot be fully checked.`)}/>}
    {!!unanalysedSources && <Alert type="info" title={t(`${unanalysedSources} 份来源尚无可读的匹配分析。可查看来源详情；不会按名称或路径代替。`, `${unanalysedSources} sources have no readable matching analysis. Inspect source details; names and paths are not substituted.`)}/>}
    {catalogs && <details><summary>{t(`本知识的 ${catalogs.sources.length} 份来源与 ${catalogs.catalogs.length} 份可读分析`, `${catalogs.sources.length} sources and ${catalogs.catalogs.length} readable analyses for this knowledge`)}</summary>
      {catalogs.sources.map((source, index) => <p className="candidate-help" key={`${source.snapshotId}/${source.sourceVersion}`}>{t(`来源 ${index + 1}：`, `Source ${index + 1}: `)}{source.status !== 'available'
        ? t('来源不可用，无法完整核对。', 'Source unavailable; evidence cannot be fully checked.') : catalogs.catalogs.some(item => item.snapshotId === source.snapshotId && item.sourceVersion === source.sourceVersion)
          ? t('有精确来源匹配的分析。', 'Exact-source analyses available.') : t('尚无可读的精确来源匹配分析；不会按名称或路径代替。', 'No readable exact-source analysis. Names or paths are not substituted.')}<br/><code>{source.snapshotId} / {source.sourceVersion}</code></p>)}
      {catalogs.catalogs.map((item, index) => <p className="candidate-help" key={item.analysisId}>{analysisOptions?.[index].label}<br/><code>{item.analysisId}</code>{item.sourceSummary?.firstRecordIndex !== undefined && <> · {t('来源记录范围：', 'Source record range: ')}{item.sourceSummary.firstRecordIndex}–{item.sourceSummary.lastRecordIndex ?? item.sourceSummary.firstRecordIndex}</>}</p>)}
    </details>}
    <div className="candidate-form">
      <label>{t('选择精确来源的实体分析', 'Choose entity analysis from exact sources')}<Select aria-label={t('选择精确来源的实体分析', 'Choose entity analysis from exact sources')} value={analysisOptions?.some(item => item.value === analysisId) ? analysisId : undefined} loading={catalogsReading} disabled={locked || catalogsReading || !!catalogsError}
        placeholder={t('选择一份来源匹配的分析', 'Choose a source-matched analysis')} options={analysisOptions}
        onChange={id => { setAnalysisId(id); setConfirmed(false); }}/></label>
      <Space wrap><Button disabled={locked || catalogsReading || !catalogs?.catalogs.some(item => item.analysisId === analysisId)} loading={reading} onClick={() => void load(catalogs?.catalogs.find(item => item.analysisId === analysisId)?.writeHeadRevisionId)}>{t('载入当前实体修订', 'Load current entity revision')}</Button>
        {bound && <Button disabled={locked} onClick={() => void load(bound.revisionId, bound.analysisId)}>{t('载入原绑定修订', 'Load bound revision')}</Button>}</Space>
      {bound && <details><summary>{t('原绑定的精确身份', 'Exact identity of the original binding')}</summary><p className="candidate-help"><code>{bound.analysisId} / {bound.revisionId}</code></p></details>}
      {selectedCatalog && <>
        <label>{t('明确选择实体修订', 'Select exact entity revision')}<Select aria-label={t('明确选择实体修订', 'Select exact entity revision')} disabled={locked} value={selectedCatalog.revision.revisionId}
          options={selectedCatalog.history.revisions.map(revision => ({ value: revision.revisionId, label: `${displayTime(revision.revisedAt)} · ${revision.revisionReason} · ${t(`${revision.entities.length} 个对象`, `${revision.entities.length} ${revision.entities.length === 1 ? 'entity' : 'entities'}`)}` }))} onChange={revision => void load(revision, selectedCatalog.history.analysisId)}/></label>
        <p className="candidate-help">{t('已载入：', 'Loaded: ')}{selectedCatalog.revision.revisionId === selectedCatalog.history.writeHeadRevisionId ? t('当前修订', 'Current revision') : t('历史修订', 'Historical revision')} · {selectedCatalog.revision.revisionReason}</p>
        <details><summary>{t('已载入的精确分析与修订', 'Exact loaded analysis and revision')}</summary><p className="candidate-help"><code>{selectedCatalog.history.analysisId} / {selectedCatalog.revision.revisionId}</code></p></details>
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
              onChange={ids => { if (!locked) { setConfirmed(false); setMappings(mappings.map(item => item === ref ? { ...item, mentionIds: ids } : item)); } }}/>
          </fieldset>)}
        </section>)}
      </>}
      <label>{t('映射修改理由', 'Mapping reason')}<Input.TextArea aria-label={t('映射修改理由', 'Mapping reason')} readOnly={locked} value={reason} onChange={event => setReason(event.target.value)}/></label>
      <Checkbox disabled={locked || !selectedCatalog} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}>{t('本次只保存实体映射，不编辑或沿用已有 typedRelations；它们的原件留在关联历史，新修订不含这些关系。我已核对上述精确实体修订与选择。', 'Save entity mappings only. Existing typedRelations are not edited or inherited; their originals remain in association history and are absent from the new revision. I checked the exact entity revision and selections above.')}</Checkbox>
    </div>
  </Drawer>;
}
