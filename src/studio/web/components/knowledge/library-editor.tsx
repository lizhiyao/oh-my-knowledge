'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Checkbox, Input, Modal, Pagination, Space, Spin } from 'antd';
import type { Language } from '../layout/shell';
import { LibraryDraftSchema, type LibraryDraft, type LibraryMember } from '../../../../knowledge/library/contracts';
import type { KnowledgeLibraryDetail } from '../../../view-models/knowledge/knowledge-library';
import type { KnowledgeEntityCatalog } from '../../../view-models/knowledge/knowledge-candidates';
import { libraryEntityUrl, requestLibrary, requestLibraryEntity } from './library-request';
import { KnowledgeRequestError } from './request';
import { useKnowledgeSave } from './save-session';
import { useLibrarySource, type LibrarySeed } from './library-source';
import { EntityLibraryDetail } from './entities';

type CatalogState = { phase: 'loading' | 'failed' } | { phase: 'ready'; value: KnowledgeEntityCatalog };
export function LibraryEditor({ workspace, lang, detail: initialDetail, seed, onClose, onSaved }: {
  workspace: string; lang: Language; detail?: KnowledgeLibraryDetail; seed?: LibrarySeed; onClose(): void; onSaved(id: string): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [detail] = useState(initialDetail);
  const [objectId] = useState(() => detail?.history.objectId ?? crypto.randomUUID());
  const [draft, setDraft] = useState<LibraryDraft>(() => detail?.revision.draft ?? { label: '', description: '', referentKind: 'object', members: [] });
  const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [catalogState, setCatalogState] = useState<CatalogState>({ phase: 'loading' });
  const catalog = catalogState.phase === 'ready' ? catalogState.value : undefined;
  const loading = catalogState.phase === 'loading';
  const source = useLibrarySource(workspace, seed);
  const preview = source.state.phase === 'ready' ? source.state.detail : undefined;
  const mentionIds = source.state.phase === 'ready' ? source.state.mentionIds : [];
  const rationale = source.state.phase === 'ready' ? source.state.rationale : '';
  const previewLoading = source.state.phase === 'loading';
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false); const [validationError, setValidationError] = useState('');
  const { session, state, busy, uncertain } = useKnowledgeSave<Parameters<typeof requestLibrary>[2] & { requestId: string; objectId: string }>(workspace);
  const error = validationError || state.error;
  const catalogError = catalogState.phase === 'failed' ? t('来源实体列表不可读，请核对工作区。', 'Source entities unavailable. Check the workspace.') : '';
  const previewError = source.state.phase === 'failed' ? t('来源实体不可读，可回到实体页检查历史。', 'Source entity unavailable. Inspect history on the entity page.') : '';
  const [catalogRetry, setCatalogRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setCatalogState({ phase: 'loading' });
    void requestLibraryEntity<KnowledgeEntityCatalog>(workspace, 'entity-catalog', { query: query.trim() || undefined, page, pageSize: 10 }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setCatalogState({ phase: 'ready', value }); })
      .catch(() => { if (!controller.signal.aborted) setCatalogState({ phase: 'failed' }); });
    return () => controller.abort();
  }, [workspace, query, page, catalogRetry]);
  const eligible = preview?.source.status === 'available' && preview.entity.identityStatus === 'proposed'
    && preview.revision.revisionId === preview.history.writeHeadRevisionId
    && (!draft.members.length && !detail || preview.entity.referentKind === draft.referentKind)
    && mentionIds.length > 0 && mentionIds.every(id => preview.mentionChecks.some(check => check.mentionId === id && check.positionStatus === 'matched'));
  const change = (value: LibraryDraft) => { setDraft(value); setConfirmed(false); };
  function add() {
    if (!preview || !eligible || !rationale.trim()) return;
    const member: LibraryMember = { analysisId: preview.history.analysisId, entityId: preview.entity.entityId, entityRevisionId: preview.revision.revisionId,
      mentionIds, rationale: rationale.trim() };
    change({ ...draft, label: draft.label || preview.entity.label, description: draft.description || preview.entity.description,
      referentKind: detail || draft.members.length ? draft.referentKind : preview.entity.referentKind,
      members: [...draft.members.filter(value => value.analysisId !== member.analysisId || value.entityId !== member.entityId), member] });
    source.clear();
  }
  async function save() {
    if (busy || uncertain) return;
    const checked = LibraryDraftSchema.safeParse({ ...draft, label: draft.label.trim(), description: draft.description.trim() });
    if (!checked.success || !reason.trim() || reason.trim().length > 4096) {
      setValidationError(t('组织草稿未通过校验。核对名称、简介、来源数量与依据；当前填写仍保留，尚未发送保存请求。', 'The organization draft is invalid. Review its name, description, source count and evidence. Your entries remain; no save request was sent.'));
      return;
    }
    setValidationError('');
    const command = { requestId: crypto.randomUUID(), objectId, generation: detail?.history.generation ?? 0,
      headRevisionId: detail?.history.writeHeadRevisionId ?? null, draft: checked.data,
      reason: reason.trim(), identityConfirmed: true as const };
    const saved = await session.save(command, (value, signal) => requestLibrary(workspace, 'save', value, signal), cause => {
      if (!(cause instanceof KnowledgeRequestError) || !cause.definiteRejection
        || !['knowledge_conflict', 'knowledge_capacity_exceeded', 'knowledge_storage_unsupported', 'knowledge_workspace_busy'].includes(cause.message)) return;
      setConfirmed(false);
      return cause.message === 'knowledge_conflict'
        ? t('对象或来源已变化，或此实体已有所属对象。关闭后重新核对组织与实体。', 'Object/source changed or this entity already has an owner. Close and review organization and entities.')
        : t('未能保存。核对来源、对象层次、身份歧义与工作区状态后再提交。', 'Save failed. Review source, referent level, ambiguity, and workspace state.');
    }, t('保存结果未知，请先核对已保存版本。', 'Save outcome unknown. Check the saved version first.'));
    if (saved?.current()) onSaved(objectId);
  }
  async function inspectSave() {
    const saved = await session.inspect((command, signal) => requestLibrary<KnowledgeLibraryDetail>(workspace, 'show', { id: command.objectId }, signal),
      (value, command) => value.history.receipts.some(receipt => receipt.requestId === command.requestId),
      t('未找到本次保存收据。请关闭后检查对象，再重新提交。', 'This save receipt was not found. Close, inspect the object, and submit again.'),
      t('仍无法核对保存状态，请稍后再检查。', 'Save status still unavailable. Check again later.'));
    if (saved?.current()) onSaved(objectId);
  }
  return <Modal open width={1000} className="carrier-authoring-modal library-editor-modal" title={detail ? t('维护知识库对象', 'Maintain library object') : t('从实体建立知识库对象', 'Create a library object from entities')}
    onCancel={() => { if (!busy) onClose(); }} closable={!busy} mask={{ closable: false }} keyboard={!busy} footer={<Space wrap>
      <Button disabled={busy} onClick={onClose}>{t('关闭', 'Close')}</Button>
      {uncertain ? <Button loading={busy} onClick={() => void inspectSave()}>{t('核对已保存版本', 'Check saved version')}</Button>
        : <Button type="primary" loading={busy} disabled={!confirmed || !reason.trim() || !draft.label.trim() || !draft.description.trim() || !detail && !draft.members.length}
          onClick={() => void save()}>{t('保存组织修订', 'Save organization revision')}</Button>}
    </Space>}>
    {error && <Alert className="knowledge-operation-feedback" type="error" title={error}/>}
    <p>{t('只维护知识的组织关联，不改写原始实体或知识。仅名称相同不能确认同一对象。', 'Maintains organization links without rewriting entities or knowledge. Equal names do not confirm identity.')}</p>
    <div className="library-editor-fields"><label>{t('对象名称', 'Object name')}<Input aria-label={t('对象名称', 'Object name')} maxLength={256} readOnly={busy || uncertain} value={draft.label} onChange={event => change({ ...draft, label: event.target.value })}/></label>
      <label>{t('用户维护简介', 'User-maintained description')}<Input.TextArea aria-label={t('用户维护简介', 'User-maintained description')} maxLength={4096} readOnly={busy || uncertain} value={draft.description} onChange={event => change({ ...draft, description: event.target.value })}/></label></div>
    <h3>{t('已选择的来源关联', 'Selected source links')}</h3>
    {draft.members.map(member => <section className="entity-mention" key={`${member.analysisId}:${member.entityId}`}>
      <Link href={libraryEntityUrl(workspace, member)}>{detail?.members.find(value => value.analysisId === member.analysisId && value.entityId === member.entityId)?.status === 'available'
        ? (detail.members.find(value => value.analysisId === member.analysisId && value.entityId === member.entityId) as Extract<KnowledgeLibraryDetail['members'][number], { status: 'available' }>).entity.label
        : catalog?.rows.find(value => value.analysisId === member.analysisId && value.entityId === member.entityId)?.label ?? t('查看已选来源实体', 'Inspect selected entity')}</Link>
      <p>{member.rationale}</p><Space wrap><Button disabled={busy || uncertain} onClick={() => source.select({ analysisId: member.analysisId, entityId: member.entityId })}>{t('重新核对此来源', 'Review this source again')}</Button>
        <Button disabled={busy || uncertain} onClick={() => change({ ...draft, members: draft.members.filter(value => value !== member) })}>{t('解除此关联', 'Unlink this source')}</Button></Space>
    </section>)}
    {!uncertain && <><h3>{t('选择要关联的来源实体', 'Select a source entity')}</h3>
      <Input.Search allowClear aria-label={t('查找来源实体', 'Find source entities')} placeholder={t('搜索名称、原文或来源', 'Search names, mentions, or sources')} onSearch={value => { setQuery(value); setPage(1); }}/>
      {!!catalog?.unavailableAnalyses && <Alert type="warning" title={t('部分实体分析不可读，可读列表不代表全部来源。', 'Some analyses are unreadable; this list does not cover all sources.')}/>}
      {catalogError && <Alert className="knowledge-operation-feedback" type="error" title={catalogError} action={<Button disabled={loading || busy} onClick={() => setCatalogRetry(value => value + 1)}>{t('重新读取来源实体', 'Reload source entities')}</Button>}/>}
      {previewError && <Alert className="knowledge-operation-feedback" type="error" title={previewError} action={<Button disabled={previewLoading || busy} onClick={() => source.retry()}>{t('重新读取所选实体', 'Reload selected entity')}</Button>}/>}
      {previewLoading && <Spin/>}
      {loading ? <Spin/> : <div className="library-source-list">{catalog?.rows.map(row => <Button key={`${row.analysisId}:${row.entityId}`} disabled={busy} onClick={() => source.select({ analysisId: row.analysisId, entityId: row.entityId })}>
        <span title={`${row.description} · ${row.qualifiers.join(' / ')}`}>{row.label} · {row.origin?.title || t('导入来源', 'Imported source')}</span></Button>)}</div>}
      {catalog && <Pagination size="small" current={catalog.page} total={catalog.total} pageSize={catalog.pageSize} showSizeChanger={false} onChange={setPage}/>}
      {preview && <div className="library-source-preview">
        <EntityLibraryDetail detail={preview} workspace={workspace} lang={lang} onRevision={revision => source.select({ analysisId: preview.history.analysisId, entityId: preview.entity.entityId, revision })}/>
        {!eligible && <Alert type="warning" title={t('此选择不能直接关联：需当前修订、可读且匹配的原文、无未解决歧义，并与对象层次一致。可在实体页先纠正。', 'This selection cannot be linked: require a current revision, readable matching evidence, resolved identity, and matching level. Correct it on the entity page first.')}/>}
        <h4>{t('用于确认身份的原文提及', 'Source mentions supporting identity')}</h4>
        <Checkbox.Group value={mentionIds} onChange={values => { source.setMentionIds(values as string[]); setConfirmed(false); }} options={preview.revision.mentions.filter(mention => mention.entityId === preview.entity.entityId).map(mention => ({ value: mention.mentionId, label: `${mention.selection.quote} · ${mention.rationale}` }))}/>
        <label>{t('此来源关联理由', 'Rationale for this source link')}<Input.TextArea aria-label={t('此来源关联理由', 'Rationale for this source link')} maxLength={4096} disabled={busy} value={rationale} onChange={event => source.setRationale(event.target.value)}/></label>
        <Button disabled={busy || !eligible || !rationale.trim()} onClick={add}>{t('确认此来源关联', 'Confirm this source link')}</Button>
      </div>}
    </>}
    <div className="library-editor-fields"><label>{t('本次维护理由', 'Reason for this revision')}<Input.TextArea aria-label={t('本次维护理由', 'Reason for this revision')} maxLength={4096} readOnly={busy || uncertain} value={reason} onChange={event => { setReason(event.target.value); setConfirmed(false); }}/></label>
      <Checkbox disabled={busy || uncertain} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}>{t('已核对原文、限定和层次，确认所选来源谈论同一对象；解除关联不会删除知识。', 'I reviewed evidence, qualifiers, and levels and confirm the selected sources concern the same object; unlinking does not delete knowledge.')}</Checkbox></div>
  </Modal>;
}
