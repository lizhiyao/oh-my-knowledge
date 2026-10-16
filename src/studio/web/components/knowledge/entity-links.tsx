'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Empty, Input, Select, Space, Spin } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeEntityLibraryDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { EntityLinkCandidates, EntityLinkStudioInspection, EntityLinkStudioList, EntityLinkStudioPreview, EntityLinkStudioQuality } from '../../../view-models/knowledge/entity-links';
import { requestKnowledge } from './request';
import { EntityLinkPreviewEvidence, EntityLinkSavedEvidence, entityLinkStatusLabel } from './entity-link-evidence';
import { notifyKnowledgeChange } from './workspace';
import { EntityLinkQualityEvidence } from './entity-link-quality';

export function EntityLinksDrawer({ workspace, detail, lang, onClose }: {
  workspace: string; detail: KnowledgeEntityLibraryDetail; lang: Language; onClose(): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [candidates, setCandidates] = useState<EntityLinkCandidates>();
  const [history, setHistory] = useState<EntityLinkStudioList>();
  const [quality, setQuality] = useState<EntityLinkStudioQuality>(), [qualityFailed, setQualityFailed] = useState(false);
  const [right, setRight] = useState<KnowledgeEntityLibraryDetail>();
  const [rightId, setRightId] = useState('');
  const [leftMentions, setLeftMentions] = useState<string[]>([]), [rightMentions, setRightMentions] = useState<string[]>([]);
  const [model, setModel] = useState(''), [preview, setPreview] = useState<EntityLinkStudioPreview>();
  const [saved, setSaved] = useState<EntityLinkStudioInspection>();
  const [reviewId, setReviewId] = useState(''), [retryOf, setRetryOf] = useState<string>();
  const [reason, setReason] = useState(''), [label, setLabel] = useState('');
  const [contentConfirmed, setContentConfirmed] = useState(false), [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const controller = useRef<AbortController | null>(null), epoch = useRef(0);
  const left = { analysisId: detail.history.analysisId, entityId: detail.entity.entityId };
  const mentionOptions = (value: KnowledgeEntityLibraryDetail) => value.revision.mentions.filter(mention => mention.entityId === value.entity.entityId)
    .map(mention => ({ value: mention.mentionId, label: `${mention.selection.quote} · ${mention.mentionId.slice(-8)}` }));
  async function api<T>(operation: string, fields: object, signal: AbortSignal): Promise<T> {
    return requestKnowledge<T>('entity-links', { workspace, operation, ...fields }, signal);
  }
  async function action(run: (signal: AbortSignal) => Promise<void>, mutation = false) {
    if (controller.current) return;
    const active = new AbortController(), current = epoch.current; controller.current = active; setBusy(true); setError('');
    try { await run(active.signal); }
    catch {
      if (!active.signal.aborted && current === epoch.current) {
        if (mutation) setUncertain(true);
        setError(mutation ? t('操作回执未确认。请核对下方同一 review；不要重新发送。', 'Operation acknowledgement is unconfirmed. Inspect the same review below; do not resend.')
          : t('读取或预检未能完成。不能据此判断没有候选或记录；请重新读取。API 凭据、来源、身份或容量未满足时，预览不会发送。', 'Read or preflight failed; this does not mean there are no candidates or records. Reload. Preview never sends when API credentials, sources, identity, or capacity are unavailable.'));
      }
    } finally { if (current === epoch.current && controller.current === active) { controller.current = null; setBusy(false); } }
  }
  async function load(signal: AbortSignal) {
    setQuality(undefined); setQualityFailed(false);
    const [catalog, observation] = await Promise.allSettled([
      Promise.all([api<EntityLinkCandidates>('candidates', { selected: left }, signal), api<EntityLinkStudioList>('list', {}, signal)]),
      api<EntityLinkStudioQuality>('quality', {}, signal),
    ]);
    if (signal.aborted) return;
    if (observation.status === 'fulfilled') setQuality(observation.value); else setQualityFailed(true);
    if (catalog.status === 'rejected') throw catalog.reason;
    setCandidates(catalog.value[0]); setHistory(catalog.value[1]);
  }
  async function inspect(id: string, signal: AbortSignal) {
    const value = await api<EntityLinkStudioInspection>('show', { reviewId: id }, signal);
    if (!signal.aborted) { setSaved(value); setPreview(undefined); setUncertain(false); setContentConfirmed(false); setIdentityConfirmed(false); setReason(''); setLabel(''); }
  }
  function accept(value: EntityLinkStudioInspection, signal: AbortSignal) {
    if (signal.aborted) return;
    setSaved(value); setPreview(undefined); setReviewId(value.history.reviewId); setContentConfirmed(false); setIdentityConfirmed(false); setUncertain(false);
    if (value.projection.status === 'applied') notifyKnowledgeChange(workspace);
  }
  useEffect(() => {
    setCandidates(undefined); setHistory(undefined); setQuality(undefined); setQualityFailed(false); setPreview(undefined); setSaved(undefined); setRight(undefined); setRightId(''); setReviewId(''); setRetryOf(undefined);
    setUncertain(false); setContentConfirmed(false); setIdentityConfirmed(false); setReason(''); setLabel(''); setModel('');
    setLeftMentions(mentionOptions(detail).map(value => value.value));
    void action(load);
    return () => { epoch.current++; controller.current?.abort(); controller.current = null; };
  }, [workspace, detail.history.analysisId, detail.entity.entityId, detail.revision.revisionId]);
  function invalidate() { setPreview(undefined); setContentConfirmed(false); }
  async function selectRight(key: string) {
    setRightId(key); setRight(undefined); setRightMentions([]); invalidate();
    const row = candidates?.rows.find(row => `${row.analysisId}:${row.entityId}` === key);
    if (!row) return;
    await action(async signal => {
      const value = await requestKnowledge<KnowledgeEntityLibraryDetail>('candidates', { workspace, operation: 'entity-detail', analysisId: row.analysisId, entityId: row.entityId }, signal);
      if (!signal.aborted) { setRight(value); setRightMentions(mentionOptions(value).map(value => value.value)); }
    });
  }
  function mutation(operation: 'resume' | 'recover-unknown' | 'cancel' | 'accept' | 'reject' | 'continue') {
    if (!saved || uncertain) return;
    const requestId = crypto.randomUUID();
    void action(async signal => {
      const value = await api<EntityLinkStudioInspection>(operation, { reviewId: saved.history.reviewId,
        ...(operation === 'continue' ? { startToken: saved.startToken, contentConfirmed: true } : operation === 'resume' ? {} : operation === 'recover-unknown' ? { requestId }
          : { requestId, expectedGeneration: saved.history.generation, reason: reason.trim(), ...(operation === 'accept' ? { identityConfirmed: true, ...(label.trim() ? { objectLabel: label.trim() } : {}) } : {}) }) }, signal);
      accept(value, signal); if (!signal.aborted) { setReason(''); await load(signal); }
    }, true);
  }
  const status = saved?.projection.status;
  return <Drawer open className="entity-links-drawer" styles={{ body: { padding: 0, overflow: 'hidden' } }} title={t('跨窗口对应', 'Cross-window identity links')} size="min(1000px, 100vw)" onClose={onClose}>
    <div className="entity-links-workbench"><header><p className="knowledge-workspace">{t('知识目录：', 'Knowledge directory: ')}{workspace}</p>
      <p>{t('名称只召回候选，不能确认同一对象。模型建议与人工接受分别保存；不会合并原实体 UUID 或原知识。', 'Names retrieve candidates, never establish identity. Model suggestions and human decisions are saved separately; original entity UUIDs and knowledge are preserved.')}</p>
      {error && <Alert type="error" showIcon title={error}/>}
      <Space wrap><Button disabled={busy} onClick={() => void action(load)}>{t('重新读取候选与历史', 'Reload candidates and history')}</Button>{busy && <Spin size="small"/>}</Space></header>
      <div className="entity-links-scroll">
        <EntityLinkQualityEvidence value={quality} failed={qualityFailed} lang={lang}/>
        <section><h3>{t('同名候选', 'Name-based candidates')}</h3>
          {!candidates ? <p>{t('候选尚未读取。', 'Candidates have not been read.')}</p> : <>
            {!!candidates.unavailableAnalyses && <Alert type="warning" title={t(`${candidates.unavailableAnalyses} 份分析不可读；候选不覆盖整个工作区。`, `${candidates.unavailableAnalyses} analyses are unreadable; candidates do not cover the workspace.`)}/>}
            {!candidates.rows.length && <Empty description={t('本次读取没有可召回候选。名称不同的实体不在此召回范围内。', 'No retrievable candidates in this read. Entities with different names are outside this retrieval policy.')}/>}
            <Select aria-label={t('选择跨窗口候选', 'Choose a cross-window candidate')} disabled={busy || uncertain} value={rightId || undefined} placeholder={t('明确选择候选', 'Choose a candidate explicitly')} onChange={value => void selectRight(value)} options={candidates.rows.map(row => ({ value: `${row.analysisId}:${row.entityId}`,
              label: `${row.label} · ${row.referentKind} · ${row.description.slice(0, 80)} · ${row.analysisId.slice(-8)} · ${row.sourceStatus}${row.ownerConflict ? ' · owner conflict' : ''}` }))}/></>}
          <label className="knowledge-field">{t('左侧选中提及', 'Selected left mentions')}<Select mode="multiple" disabled={busy || uncertain} value={leftMentions} onChange={value => { setLeftMentions(value); invalidate(); }} options={mentionOptions(detail)}/></label>
          {right && <><p>{right.entity.description}</p><label className="knowledge-field">{t('右侧选中提及', 'Selected right mentions')}<Select mode="multiple" disabled={busy || uncertain} value={rightMentions} onChange={value => { setRightMentions(value); invalidate(); }} options={mentionOptions(right)}/></label></>}
          <label className="knowledge-field">{t('API 模型（明确填写）', 'API model (enter explicitly)')}<Input value={model} maxLength={1024} disabled={busy || uncertain} onChange={event => { setModel(event.target.value); invalidate(); }}/></label>
          <p className="candidate-help">{t('当前仅开放已有归档容量证明的 OpenAI 兼容 API。Codex 尚无容量证明，发送前拒绝。', 'Only the proven OpenAI-compatible API archive path is available. Codex is rejected before sending until capacity is proven.')}</p>
          {retryOf && <p>{t('显式新尝试的前置 review：', 'Explicit new attempt follows review: ')}<code>{retryOf}</code></p>}
          <Button disabled={busy || uncertain || !right || !leftMentions.length || !rightMentions.length || !model.trim()} onClick={() => void action(async signal => {
            if (!right) return;
            const value = await api<EntityLinkStudioPreview>('preview', { left: { ...left, mentionIds: leftMentions }, right: { analysisId: right.history.analysisId, entityId: right.entity.entityId, mentionIds: rightMentions }, selection: { executor: 'openai-api', model }, retryOf: retryOf ?? null }, signal);
            if (!signal.aborted) { setPreview(value); setSaved(undefined); setReviewId(value.preview.reviewId); setContentConfirmed(false); setIdentityConfirmed(false); }
          })}>{t('本地预览精确发送内容', 'Preview exact content locally')}</Button>
        </section>
        {preview && <EntityLinkPreviewEvidence value={preview} lang={lang}/>}
        <section><h3>{t('持久 review 历史', 'Durable review history')}</h3>
          {!history ? <p>{t('历史尚未读取。', 'History has not been read.')}</p> : !history.length ? <p>{t('本次读取没有持久记录。预览本身不创建记录。', 'This read contains no durable reviews. Preview alone creates no record.')}</p> : <ul>{history.map(row => <li key={row.reviewId}><Button type="link" disabled={busy} onClick={() => { setReviewId(row.reviewId); void action(signal => inspect(row.reviewId, signal)); }}>{row.reviewId} · {entityLinkStatusLabel(row.status, lang)}</Button></li>)}</ul>}
          <label className="knowledge-field">{t('核对同一 review ID', 'Inspect the same review ID')}<Input value={reviewId} disabled={busy} onChange={event => setReviewId(event.target.value)}/></label>
          <Button disabled={busy || !reviewId.trim()} onClick={() => void action(signal => inspect(reviewId.trim(), signal))}>{t('读取同一 review（不发送）', 'Read this review (no sending)')}</Button>
        </section>
        {saved && <EntityLinkSavedEvidence value={saved} lang={lang}/>}
        {saved && (status === 'awaiting_review' || status === 'prepared') && <label className="knowledge-field">{t('人工处理理由', 'Human decision reason')}<Input.TextArea rows={3} maxLength={4096} value={reason} readOnly={busy || uncertain} onChange={event => setReason(event.target.value)}/></label>}
        {status === 'awaiting_review' && <><label className="knowledge-field">{t('新知识库对象名称（可选）', 'New library object label (optional)')}<Input maxLength={256} value={label} readOnly={busy || uncertain} onChange={event => setLabel(event.target.value)}/></label>
          <Checkbox checked={identityConfirmed} disabled={busy || uncertain} onChange={event => setIdentityConfirmed(event.target.checked)}>{t('我已独立核对两侧来源与身份，确认是同一对象。', 'I independently checked both sources and confirm these are the same entity.')}</Checkbox></>}
      </div>
      <footer className="entity-links-footer">
        {(preview || status === 'prepared') && <Checkbox checked={contentConfirmed} disabled={busy || uncertain} onChange={event => setContentConfirmed(event.target.checked)}>{t('我已核对当前工作区、完整发送内容、选中提及、模型与 endpoint，确认发送一次。', 'I checked this workspace, full content, selected mentions, model, and endpoint, and confirm one invocation.')}</Checkbox>}
        <Space wrap>{preview && <Button disabled={busy || uncertain} onClick={() => void action(async signal => { await api('discard-preview', { previewToken: preview.previewToken }, signal); if (!signal.aborted) { setPreview(undefined); setContentConfirmed(false); } })}>{t('取消此预览', 'Discard this preview')}</Button>}{preview && <Button type="primary" loading={busy} disabled={!contentConfirmed || busy || uncertain} onClick={() => {
          if (!contentConfirmed) return;
          const selected = preview; setContentConfirmed(false);
          void action(async signal => { const value = await api<EntityLinkStudioInspection>('propose', { previewToken: selected.previewToken, contentConfirmed: true }, signal); accept(value, signal); if (!signal.aborted) await load(signal); }, true);
        }}>{t('发送以上内容，生成关联建议', 'Send this content to propose a link')}</Button>}
          {status === 'prepared' && <><Button type="primary" disabled={busy || uncertain || !contentConfirmed || !saved?.startToken} onClick={() => mutation('continue')}>{t('确认继续已预约调用', 'Confirm and start prepared invocation')}</Button><Button disabled={busy || uncertain || !reason.trim()} onClick={() => mutation('cancel')}>{t('发送前取消预约', 'Cancel before sending')}</Button></>}
          {status === 'awaiting_review' && <><Button type="primary" disabled={busy || uncertain || !identityConfirmed || !reason.trim()} onClick={() => mutation('accept')}>{t('人工接受并组织知识库', 'Accept and organize the library')}</Button><Button disabled={busy || uncertain || !reason.trim()} onClick={() => mutation('reject')}>{t('人工拒绝，保留历史', 'Reject and preserve history')}</Button></>}
          {saved && <Button disabled={busy} onClick={() => void action(async signal => { const value = await api<EntityLinkStudioInspection>('resume', { reviewId: saved.history.reviewId }, signal); accept(value, signal); })}>{t('恢复归档／组织（不发送）', 'Resume archive / organization (no sending)')}</Button>}
          {status === 'running' && <Button disabled={busy || uncertain} onClick={() => mutation('recover-unknown')}>{t('核验原进程退出后记为未知', 'Verify exited owner and record unknown')}</Button>}
          {(status === 'execution_unknown' || status === 'execution_failed') && <Button disabled={busy || uncertain} onClick={() => { setRetryOf(saved!.history.reviewId); setSaved(undefined); invalidate(); }}>{t('明确准备新尝试（需重新预览确认）', 'Prepare a new attempt (renew preview and consent)')}</Button>}
        </Space>
      </footer>
    </div>
  </Drawer>;
}
