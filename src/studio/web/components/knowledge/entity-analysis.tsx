'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input, Select, Space, Spin, Tag } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeCandidateRun, KnowledgeEntityAnalysisDetail } from '../../../view-models/knowledge/knowledge-candidates';
import { displayTime } from '../../../application/display/format';

type Draft = Pick<KnowledgeEntityAnalysisDetail['revision'], 'entities' | 'mentions'>;
type Entity = Draft['entities'][number];
// Preserve blank editing lines so pressing Enter can actually add another item.
const lines = (text: string) => text.split('\n');
const savedLines = (values: string[]) => values.map(value => value.trim()).filter(Boolean);
const optionLabel = (entity: Entity) => `${entity.label || '—'} · ${entity.qualifiers.join(' / ') || entity.description.slice(0, 48)} · ${entity.entityId.slice(-8)}`;

/** Counts describe the original extraction; opening inspection reads the current analysis history. */
export function EntityAnalysisSummary({ run, lang, disabled = false, onOpen }: {
  run: Pick<KnowledgeCandidateRun, 'entityAnalysis' | 'status'>; lang: Language; disabled?: boolean; onOpen(id: string): void;
}) {
  const analysis = run.entityAnalysis;
  if (!analysis) return null;
  return <div className="entity-summary"><p>{lang === 'zh'
    ? `首次分析：${analysis.entityCount} 个对象，${analysis.mentionCount} 处提及，${analysis.unresolvedCount} 个身份待确定；${analysis.rejectedCount} 项未通过结构接纳。`
    : `Initial analysis: ${analysis.entityCount} entities, ${analysis.mentionCount} mentions, ${analysis.unresolvedCount} unresolved; ${analysis.rejectedCount} entries failed structural admission.`}</p>
    <Button disabled={disabled} onClick={() => onOpen(analysis.analysisId)}>{lang === 'zh' ? '核对实体与指代' : 'Inspect entities and references'}</Button>
  </div>;
}

export function EntityAnalysisDrawer({ workspace, analysisId, initialRevision, lang, onClose, onSaved }: {
  workspace: string; analysisId: string; initialRevision?: string; lang: Language; onClose(): void; onSaved?(): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [detail, setDetail] = useState<KnowledgeEntityAnalysisDetail>();
  const [draft, setDraft] = useState<Draft>({ entities: [], mentions: [] });
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  const controller = useRef<AbortController | null>(null);
  async function api<T>(operation: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const response = await fetch('/api/knowledge/candidates', { method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, operation, analysisId, ...fields }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error);
    return value as T;
  }
  async function request(action: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setError('');
    try { await action(active.signal); } catch (cause) {
      if (!active.signal.aborted) setError(cause instanceof Error && cause.message === 'knowledge_conflict'
        ? t('已有新的修订。草稿仍在这里；重新读取最新修订后再纠正。', 'A newer revision exists. Your draft is here; reload the current revision before correcting it.')
        : t('未能完成。请核对必填内容、提及对应及来源是否可用；若保存确认丢失，先重新读取。', 'Could not complete. Check required fields, assignments, and source availability. Reload first if the save acknowledgement was lost.'));
    } finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  function accept(value: KnowledgeEntityAnalysisDetail) {
    setDetail(value); setDraft(structuredClone({ entities: value.revision.entities, mentions: value.revision.mentions })); setReason('');
  }
  function load(revision?: string) { return request(async signal => {
    const value = await api<KnowledgeEntityAnalysisDetail>('entities', revision ? { revision } : {}, signal);
    if (!signal.aborted) { accept(value); setNotice(''); }
  }); }
  useEffect(() => { void load(initialRevision); return () => { controller.current?.abort(); controller.current = null; }; }, []);
  const current = detail?.revision.revisionId === detail?.history.writeHeadRevisionId;
  const editable = !!detail && current && detail.source.status === 'available' && !busy;
  const changed = !!detail && JSON.stringify(draft) !== JSON.stringify({ entities: detail.revision.entities, mentions: detail.revision.mentions });
  const basicComplete = draft.entities.every(entity => entity.label.trim() && entity.description.trim()
    && draft.mentions.some(mention => mention.entityId === entity.entityId)
    && (entity.identityStatus !== 'unresolved' || savedLines(entity.uncertainties).length)
    && entity.possibleEntityIds.every(id => id !== entity.entityId && draft.entities.some(target => target.entityId === id && target.identityStatus === 'proposed')))
    && draft.mentions.every(mention => mention.rationale.trim());
  return <Drawer open className="entity-analysis-drawer" title={t('核对实体与指代', 'Inspect entities and references')} size="min(900px, 100vw)" onClose={() => { controller.current?.abort(); onClose(); }}
    extra={<Space><Button disabled={busy} onClick={() => void load()}>{changed ? t('重新读取（放弃草稿）', 'Reload (discard draft)') : t('读取最新修订', 'Load current revision')}</Button>
      <Button type="primary" disabled={!editable || !changed || !reason.trim() || !basicComplete} loading={busy && !!detail} onClick={() => void request(async signal => {
        if (!detail) return;
        const saved = await api<KnowledgeEntityAnalysisDetail>('correct-entities', { revision: detail.revision.revisionId,
          generation: detail.history.generation, draft: { ...draft, entities: draft.entities.map(entity => ({ ...entity,
            qualifiers: savedLines(entity.qualifiers), uncertainties: savedLines(entity.uncertainties) })) }, reason: reason.trim() }, signal);
        if (!signal.aborted) { accept(saved); setNotice(t('已保存实体新修订。需要在知识中明确应用此修订。', 'Saved a new entity revision. Apply it explicitly from a knowledge candidate.')); onSaved?.(); }
      })}>{t('保存实体新修订', 'Save new entity revision')}</Button></Space>}>
    {error && <Alert type="error" showIcon title={error}/>} {notice && <Alert type="success" title={notice}/>}
    {!detail ? busy ? <Spin/> : <Empty description={t('实体分析尚不可读。若运行未保存完成，请先恢复提炼运行。', 'Analysis is not readable yet. Resume an unfinished extraction first.')}/>
      : <><EntityAnalysisContext detail={detail} lang={lang}/>
        <label className="entity-history-label">{t('查看修订', 'Inspect revision')}<Select disabled={busy || changed} value={detail.revision.revisionId} style={{ width: '100%' }}
          onChange={revision => void load(revision)} options={detail.history.revisions.map((revision, index) => ({ value: revision.revisionId,
            label: `${index + 1} · ${displayTime(revision.revisedAt)} · ${revision.revisionReason}` }))}/></label>
        {!current && <Alert type="info" title={t('正在查看历史修订。读取最新修订后可纠正。', 'Viewing a historical revision. Load the current revision to correct it.')}/>}
        <EntityAnalysisEditor detail={detail} draft={draft} editable={editable} lang={lang} onChange={setDraft}/>
        {!basicComplete && editable && <Alert type="info" title={t('请补齐对象名称、描述和原文提及；歧义需有理由，可能目标须指向明确提出的对象。', 'Complete names, descriptions, and source mentions. Unresolved identities need reasons and proposed targets.')}/>}
        <label className="entity-history-label">{t('纠正理由', 'Correction reason')}<Input.TextArea disabled={!editable} value={reason} rows={2}
          placeholder={t('说明哪些对象或对应关系需要纠正，以及原文依据。', 'Describe the correction and the original evidence.')} onChange={event => setReason(event.target.value)}/></label>
      </>}
  </Drawer>;
}

export function EntityAnalysisContext({ detail, lang }: { detail: KnowledgeEntityAnalysisDetail; lang: Language }) {
  const zh = lang === 'zh';
  return <div className="entity-analysis-context">
    <p>{zh ? '核对这些提及是否谈论同一对象。纠正会留下新修订；知识中已绑定的版本需另行应用。' : 'Check whether mentions refer to the same entity. Corrections create a new revision; apply it separately to bound knowledge.'}</p>
    <p>{zh ? '本修订：' : 'This revision: '}{detail.revision.entities.length} {zh ? '个对象' : 'entities'} / {detail.revision.mentions.length} {zh ? '处提及' : 'mentions'} · {displayTime(detail.revision.revisedAt)} · {detail.revision.revisedBy.actorId}</p>
    <p>{detail.revision.revisionReason}</p>
    {detail.source.status === 'unavailable' && <Alert type="warning" title={zh ? '来源快照不可用；仅可查看保存的提及，不能重新核对或纠正。' : 'Source snapshot unavailable. Saved mentions remain visible; rechecking and corrections are unavailable.'}/>}
    {detail.revision.limitations.map((limitation, index) => <p className="candidate-help" key={index}>{limitation}</p>)}
  </div>;
}

/** User-authored local edits only. Admission and host identities are owned by the application. */
export function EntityAnalysisEditor({ detail, draft, editable, lang, onChange }: {
  detail: KnowledgeEntityAnalysisDetail; draft: Draft; editable: boolean; lang: Language; onChange(value: Draft): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [selected, setSelected] = useState(draft.entities[0]?.entityId ?? '');
  const [mergeTarget, setMergeTarget] = useState<string>();
  const [excerptId, setExcerptId] = useState('');
  const [range, setRange] = useState<{ start: number; end: number }>();
  const excerptField = useRef<HTMLTextAreaElement | null>(null);
  const entity = draft.entities.find(value => value.entityId === selected);
  const excerpts = detail.source.status === 'available' ? detail.source.excerpts : [];
  const excerpt = excerpts.find(value => value.evidenceRef === excerptId);
  const mentions = draft.mentions.filter(mention => mention.entityId === selected);
  function edit(action: (next: Draft) => void) { const next = structuredClone(draft); action(next); onChange(next); }
  function changeEntity(patch: Partial<Entity>) { edit(next => { const entity = next.entities.find(value => value.entityId === selected); if (entity) Object.assign(entity, patch); }); }
  function inspect(selection: Draft['mentions'][number]['selection']) {
    setExcerptId(selection.evidenceRef); setRange({ start: selection.start, end: selection.end });
  }
  useEffect(() => { if (range && excerptField.current) { excerptField.current.focus(); excerptField.current.setSelectionRange(range.start, range.end); } }, [excerptId, range]);
  useEffect(() => { if (!draft.entities.some(entity => entity.entityId === selected)) setSelected(draft.entities[0]?.entityId ?? ''); }, [draft, selected]);
  return <div className="entity-editor">
    <div className="entity-editor-list"><h3>{t('对象', 'Entities')}</h3>
      {draft.entities.length ? <Select aria-label={t('选择核对对象', 'Choose entity')} style={{ width: '100%' }} value={selected} onChange={value => { setSelected(value); setMergeTarget(undefined); }}
        options={draft.entities.map(entity => ({ value: entity.entityId, label: optionLabel(entity) }))}/> : <Empty description={t('没有接纳的实体。可从来源补充遗漏的提及。', 'No admitted entities. Add omitted mentions from the source.')}/>}
      <Button disabled={!editable} onClick={() => {
        const entityId = `new:${crypto.randomUUID()}`; edit(next => next.entities.push({ entityId, label: '', description: '', qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [] })); setSelected(entityId);
      }}>{t('新增对象／拆分对象', 'Add or split an entity')}</Button>
      {entity && <div className="candidate-form">
        <label>{t('名称', 'Name')}<Input disabled={!editable} value={entity.label} onChange={event => changeEntity({ label: event.target.value })}/></label>
        <label>{t('描述这个对象', 'Describe this entity')}<Input.TextArea disabled={!editable} value={entity.description} rows={2} onChange={event => changeEntity({ description: event.target.value })}/></label>
        <label>{t('项目／版本／环境等限定（每行一项）', 'Project/version/environment qualifiers (one per line)')}<Input.TextArea disabled={!editable} value={entity.qualifiers.join('\n')} rows={2} onChange={event => changeEntity({ qualifiers: lines(event.target.value) })}/></label>
        <label>{t('身份对应', 'Identity assignment')}<Select disabled={!editable} value={entity.identityStatus} options={[
          { value: 'proposed', label: t('提出对应，待核对', 'Proposed assignment, needs review') }, { value: 'unresolved', label: t('无法确定，保留歧义', 'Unresolved, retain ambiguity') },
        ]} onChange={identityStatus => changeEntity({ identityStatus, ...(identityStatus === 'proposed' ? { possibleEntityIds: [] } : {}) })}/></label>
        {entity.identityStatus === 'unresolved' && <label>{t('可能对应的对象（也可以未知）', 'Possible entities (may remain unknown)')}<Select mode="multiple" disabled={!editable} value={entity.possibleEntityIds}
          options={draft.entities.filter(value => value.entityId !== selected && value.identityStatus === 'proposed').map(value => ({ value: value.entityId, label: optionLabel(value) }))}
          onChange={possibleEntityIds => changeEntity({ possibleEntityIds })}/></label>}
        <label>{t('不确定性与理由（每行一项；歧义对象必填）', 'Uncertainties and reasons (one per line; required if unresolved)')}<Input.TextArea disabled={!editable} value={entity.uncertainties.join('\n')} rows={2} onChange={event => changeEntity({ uncertainties: lines(event.target.value) })}/></label>
        <details><summary>{t('合并或删除此对象', 'Merge or remove this entity')}</summary>
          <Select aria-label={t('合并到对象', 'Merge into entity')} disabled={!editable} value={mergeTarget} style={{ width: '100%' }} placeholder={t('明确选择合并目标', 'Explicitly choose the merge target')}
            options={draft.entities.filter(value => value.entityId !== selected && value.identityStatus === 'proposed').map(value => ({ value: value.entityId, label: optionLabel(value) }))} onChange={setMergeTarget}/>
          <Button disabled={!editable || !mergeTarget} onClick={() => { if (!mergeTarget) return; edit(next => {
            next.mentions = next.mentions.map(mention => mention.entityId === selected ? { ...mention, entityId: mergeTarget, rationale: t('用户纠正对应；具体依据见本修订理由。', 'Assignment corrected by user; see this revision’s reason for evidence.') } : mention);
            next.entities = next.entities.filter(value => value.entityId !== selected).map(value => ({ ...value,
              possibleEntityIds: [...new Set(value.possibleEntityIds.map(id => id === selected ? mergeTarget : id))].filter(id => id !== value.entityId) }));
          }); setSelected(mergeTarget); setMergeTarget(undefined); }}>{t('合并提及到所选对象', 'Merge mentions into selected entity')}</Button>
          <Button danger disabled={!editable} onClick={() => edit(next => {
            next.entities = next.entities.filter(value => value.entityId !== selected).map(value => ({ ...value, possibleEntityIds: value.possibleEntityIds.filter(id => id !== selected) }));
            next.mentions = next.mentions.filter(mention => mention.entityId !== selected);
          })}>{t('删除此对象及其提及', 'Remove this entity and its mentions')}</Button>
        </details>
      </div>}
    </div>
    <div className="entity-editor-evidence"><h3>{t('提及与原文', 'Mentions and source')}</h3>
      {entity && !mentions.length && <Alert type="warning" title={t('此对象还没有原文提及。请补充或删除此对象后再保存。', 'This entity has no source mention. Add one or remove the entity before saving.')}/>}
      {mentions.map(mention => <section className="candidate-statement" key={mention.mentionId}>
        <p><Tag>{mention.basis === 'explicit' ? t('明确提及', 'Explicit') : t('推断对应', 'Inferred assignment')}</Tag><q>{mention.selection.quote}</q></p>
        <Button size="small" disabled={detail.source.status === 'unavailable'} onClick={() => inspect(mention.selection)}>{t('定位原文', 'Locate source')}</Button>
        <label>{t('这一处对应哪个对象', 'Entity for this mention')}<Select disabled={!editable} style={{ width: '100%' }} value={mention.entityId}
          options={draft.entities.map(value => ({ value: value.entityId, label: optionLabel(value) }))} onChange={entityId => edit(next => {
            const value = next.mentions.find(value => value.mentionId === mention.mentionId)!; value.entityId = entityId;
            value.rationale = t('用户纠正对应；具体依据见本修订理由。', 'Assignment corrected by user; see this revision’s reason for evidence.');
          })}/></label>
        <label>{t('对应依据', 'Assignment rationale')}<Input.TextArea disabled={!editable} rows={2} value={mention.rationale} onChange={event => edit(next => { next.mentions.find(value => value.mentionId === mention.mentionId)!.rationale = event.target.value; })}/></label>
        <Select aria-label={t('提及依据类别', 'Mention basis')} disabled={!editable} value={mention.basis} options={[
          { value: 'explicit', label: t('原文明示', 'Explicit in source') }, { value: 'inference', label: t('根据上下文推断', 'Inferred from context') },
        ]} onChange={basis => edit(next => { next.mentions.find(value => value.mentionId === mention.mentionId)!.basis = basis; })}/>
        <Button danger size="small" disabled={!editable} onClick={() => edit(next => { next.mentions = next.mentions.filter(value => value.mentionId !== mention.mentionId); })}>{t('删除误识别提及', 'Remove false mention')}</Button>
      </section>)}
      {detail.source.status === 'available' && <div className="candidate-form">
        <label>{t('来源消息', 'Source message')}<Select style={{ width: '100%' }} value={excerptId || undefined} onChange={value => { setExcerptId(value); setRange(undefined); }}
          options={excerpts.map(value => ({ value: value.evidenceRef, label: `${value.recordIndex} · ${value.role ?? value.eventKind} · ${value.text.slice(0, 90)}` }))}/></label>
        {excerpt && <><textarea className="entity-source-text" ref={excerptField} readOnly rows={8} value={excerpt.text} aria-label={t('来源原文；选中文字可补充提及', 'Source text; select text to add a mention')}
          onSelect={event => { const { selectionStart: start, selectionEnd: end } = event.currentTarget; setRange(previous => end <= start ? undefined : previous?.start === start && previous.end === end ? previous : { start, end }); }}/>
          {range && <p>{t('已选原文：', 'Selected text: ')}<q>{excerpt.text.slice(range.start, range.end)}</q></p>}
          <p className="candidate-help">{t('选中原文中的短语，为当前对象补充遗漏提及。重复短语由实际选中位置区分。', 'Select a phrase to add an omitted mention for the current entity. The selected position distinguishes repeated phrases.')}</p>
          <Button disabled={!editable || !entity || !range || range.end <= range.start || draft.mentions.some(mention => mention.selection.evidenceRef === excerptId && mention.selection.start === range.start && mention.selection.end === range.end)} onClick={() => {
            if (!range || !entity) return;
            edit(next => next.mentions.push({ mentionId: `new:${crypto.randomUUID()}`, entityId: selected,
              selection: { evidenceRef: excerptId, start: range.start, end: range.end, quote: excerpt.text.slice(range.start, range.end) },
              basis: 'explicit', rationale: t('用户补充原文提及；具体依据见本修订理由。', 'Source mention added by user; see this revision’s reason for evidence.') }));
          }}>{t('把选中原文记为提及', 'Add selected text as a mention')}</Button></>}
      </div>}
    </div>
  </div>;
}
