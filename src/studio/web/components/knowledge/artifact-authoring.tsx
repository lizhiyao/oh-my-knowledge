'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Checkbox, Empty, Input, Modal, Select, Space, Spin, Tabs } from 'antd';
import type { Language } from '../layout/shell';
import { KnowledgeRequestError, requestKnowledge } from './request';
import { CarrierKnowledgeReviewPanel, CarrierSelectionReview } from './carrier-knowledge-review';
import type { AuthoredArtifactKind, ReviewedCarrierDetail, ReviewedCarrierDraft, CarrierRow, CarrierSource, CarrierKnowledgeReview } from '../../../view-models/knowledge/artifact-authoring';
import type { KnowledgeCandidateRow } from '../../../view-models/knowledge/knowledge-candidates';
import { KNOWLEDGE_INDEX_PATH } from '../../../http/page-paths';
import { workspaceHref } from '../layout/workspace-link';

export async function requestArtifact<T>(workspace: string, operation: string, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  return requestKnowledge<T>('artifacts', { workspace, operation, ...fields }, signal);
}
export function CarrierContentReview({ content, original, lang, onChange, readOnly = false }: { content: string; original: string; lang: Language; onChange(value: string): void; readOnly?: boolean }) {
  const zh = lang === 'zh';
  return <Tabs className="carrier-review-tabs" items={[
    { key: 'content', label: zh ? '核对并编辑新内容' : 'Review and edit new content', children: <Input.TextArea className="carrier-editor" readOnly={readOnly} aria-label={zh ? '载体内容' : 'Artifact content'} value={content} onChange={event => onChange(event.target.value)}/> },
    ...(original ? [{ key: 'original', label: zh ? '原内容' : 'Original content', children: <pre className="carrier-original">{original}</pre> }] : []),
  ]}/>;
}

export function ArtifactAuthoringDialog({ workspace, lang, ids = [], existing, onClose, onSaved }: {
  workspace: string; lang: Language; ids?: string[]; existing?: CarrierRow; onClose(): void; onSaved?(detail: ReviewedCarrierDetail): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const router = useRouter();
  const [rows, setRows] = useState<KnowledgeCandidateRow[]>([]);
  const [carriers, setCarriers] = useState<CarrierRow[]>([]);
  const [initialIds] = useState(ids);
  const [selected, setSelected] = useState(ids);
  const [mode, setMode] = useState<'new' | 'library' | 'local'>(existing ? 'library' : 'new');
  const [target, setTarget] = useState(existing?.artifactId ?? '');
  const [path, setPath] = useState('');
  const [kind, setKind] = useState<AuthoredArtifactKind>(existing?.artifactKind ?? 'skill');
  const [name, setName] = useState(existing?.name ?? '');
  const [draft, setDraft] = useState<ReviewedCarrierDraft | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [loadingBaseline, setLoadingBaseline] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadRetry, setLoadRetry] = useState(0); const [baselineRetry, setBaselineRetry] = useState(0);
  const [loadError, setLoadError] = useState(''); const [baselineError, setBaselineError] = useState(''); const [baselineLoaded, setBaselineLoaded] = useState(false);
  const [stalePreview, setStalePreview] = useState(false); const writeController = useRef<AbortController | null>(null);
  useEffect(() => () => { writeController.current?.abort(); writeController.current = null; }, [workspace]);
  const [baselineReview, setBaselineReview] = useState<CarrierKnowledgeReview | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setLoaded(false); setRows([]); setCarriers([]); setLoadError('');
    void Promise.all([
      requestKnowledge<KnowledgeCandidateRow[]>('candidates', { workspace, operation: 'list' }, controller.signal),
      requestArtifact<CarrierRow[]>(workspace, 'list', {}, controller.signal),
    ]).then(([knowledge, artifacts]) => { if (controller.signal.aborted) return; setRows(knowledge.filter(row => row.choice === 'retain')); setCarriers(artifacts); setLoaded(true); })
      .catch(() => { if (!controller.signal.aborted) setLoadError(t('未能读取知识或载体，请重新读取。不能据此判断没有可用知识。', 'Could not load knowledge or artifacts. Reload; this does not mean no knowledge is available.')); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [workspace, loadRetry]);
  useEffect(() => {
    if (mode !== 'library' || !target || !loaded) { setLoadingBaseline(false); setBaselineLoaded(false); setBaselineReview(null); return; }
    const controller = new AbortController(); setLoadingBaseline(true); setBaselineLoaded(false); setBaselineReview(null); setBaselineError('');
    void requestArtifact<ReviewedCarrierDetail>(workspace, 'show', { id: target }, controller.signal)
      .then(detail => { if (!controller.signal.aborted) { setBaselineReview(detail.knowledgeReview); setSelected([...new Set([...initialIds, ...detail.knowledgeRefs.map(ref => ref.knowledgeId)])].filter(id => rows.some(row => row.knowledgeId === id))); setBaselineLoaded(true); } })
      .catch(() => { if (!controller.signal.aborted) setBaselineError(t('未能读取已有知识选择，请重新读取后再生成。', 'Could not load the saved selection. Reload before generating.')); })
      .finally(() => { if (!controller.signal.aborted) setLoadingBaseline(false); });
    return () => controller.abort();
  }, [workspace, mode, target, rows, initialIds, loaded, baselineRetry]);
  const source: CarrierSource = mode === 'new' ? { sourceKind: 'new' } : mode === 'library' ? { sourceKind: 'library', artifactId: target } : { sourceKind: 'local', path };
  const failure = (cause: unknown) => cause instanceof Error && cause.message === 'knowledge_workspace_busy'
    ? t('知识工作区正在写入，当前草稿未保存。请稍后重试。', 'The knowledge workspace is busy. This draft was not saved; retry shortly.')
    : cause instanceof Error && cause.message === 'knowledge_storage_unsupported'
    ? t('所选工作区含不支持的记录格式。请核对知识目录，当前草稿仍在这里。', 'The selected workspace contains an unsupported record format. Check the knowledge directory; your draft remains here.')
    : cause instanceof Error && cause.message === 'carrier_knowledge_region_conflict' ? t('旧载体的知识区经过编辑或无法可靠识别，未重建。请创建新载体，并核对需要保留的手工内容。', 'The old knowledge region was edited or cannot be identified safely. Create a new artifact and review manual content to keep.') : cause instanceof Error && cause.message === 'carrier_source_contains_destination' ? t('本地 skill 目录包含当前保存目录，不能复制到自身内部。请选择其它知识保存目录后再生成。', 'The local skill contains the save directory and cannot be copied into itself. Choose another knowledge directory before generating.') : cause instanceof Error && cause.message === 'carrier_invalid_skill' ? t('skill 需保留有效头部，name 应与下方保存目录名一致，并填写 description。请编辑后再保存。', 'Keep valid skill frontmatter: name must match the save directory below, with a nonempty description. Edit and save again.') : cause instanceof Error && cause.message === 'carrier_conflict'
    ? t('知识或载体已发生变化，请返回选择并重新生成预览。', 'Knowledge or artifact changed. Return to selection and generate a new preview.')
    : t('操作未完成。请检查选择、文件路径或内容大小。', 'Operation failed. Check your selections, file path or content size.');
  const finish = (detail: ReviewedCarrierDetail) => { onSaved?.(detail); onClose(); router.push(workspaceHref(`${KNOWLEDGE_INDEX_PATH}?artifact=${encodeURIComponent(detail.artifactId)}`, workspace)); };
  async function preview() {
    if (writeController.current) return;
    const active = new AbortController(); writeController.current = active; setBusy(true); setError('');
    try { const next = await requestArtifact<ReviewedCarrierDraft>(workspace, 'preview', { source, artifactKind: kind, name, ids: selected }, active.signal); if (!active.signal.aborted) { setDraft(next); setContent(next.content); setStalePreview(false); } }
    catch (cause) { if (!active.signal.aborted) setError(cause instanceof Error && cause.message === 'carrier_invalid_metadata'
      ? t('本地文件头部需要有效的 YAML 属性；prompt 的 tags 应为字符串列表，skill 的 metadata 应为映射。请核对文件后再生成。', 'Use valid YAML properties in the source: prompt tags must be a string list and skill metadata a mapping. Review the file before generating.') : failure(cause)); } finally { if (writeController.current === active) { writeController.current = null; if (!active.signal.aborted) setBusy(false); } }
  }
  async function save() {
    if (!draft || uncertain || stalePreview || writeController.current) return;
    const active = new AbortController(); writeController.current = active; setBusy(true); setError('');
    try { const saved = await requestArtifact<ReviewedCarrierDetail>(workspace, 'save', { artifactId: draft.artifactId, source: draft.source, artifactKind: draft.artifactKind, name: draft.name, directoryName: draft.directoryName, baselineRevisionId: draft.baselineRevisionId, baselineHash: draft.baselineHash, content, selectedRefs: draft.selectedRefs, tagSelections: draft.tagSelections }, active.signal); if (!active.signal.aborted) finish(saved); }
    catch (cause) {
      if (active.signal.aborted) return;
      if (cause instanceof Error && cause.message === 'carrier_conflict') setStalePreview(true);
      if (cause instanceof KnowledgeRequestError && cause.definiteRejection && ['carrier_conflict', 'carrier_capacity_exceeded', 'request_body_too_large', 'carrier_invalid_skill', 'carrier_source_contains_destination', 'knowledge_workspace_busy', 'knowledge_storage_unsupported'].includes(cause.message)) setError(failure(cause));
      else { setUncertain(true); setError(t('保存结果未能读取，请先核对已保存版本。', 'Save result could not be read. Check the saved version first.')); }
    } finally { if (writeController.current === active) { writeController.current = null; if (!active.signal.aborted) setBusy(false); } }
  }
  async function readSaved() {
    if (!draft || writeController.current) return;
    const active = new AbortController(); writeController.current = active; setBusy(true);
    try {
      const saved = await requestArtifact<ReviewedCarrierDetail>(workspace, 'show', { id: draft.artifactId }, active.signal);
      if (active.signal.aborted) return;
      if (!saved.drifted && saved.content === content && draft.selectedRefs.every(ref => saved.knowledgeRefs.some(item => item.knowledgeId === ref.knowledgeId && item.revisionId === ref.revisionId && item.generation === ref.generation)) && (saved.baseline?.contentHash === draft.baselineHash && saved.baseline.revisionId === draft.baselineRevisionId || draft.baselineHash === null && saved.version === 1)) finish(saved);
      else setError(t('未能确认本次内容已保存。关闭后查看载体，再重新生成预览。', 'Could not confirm this save. Close, inspect the artifact, then generate a new preview.'));
    } catch { if (!active.signal.aborted) setError(t('未能确认保存结果。请稍后再次核对。', 'Could not confirm the save. Check again later.')); }
    finally { if (writeController.current === active) { writeController.current = null; if (!active.signal.aborted) setBusy(false); } }
  }
  return <Modal open width={900} className="carrier-authoring-modal" title={t('生成知识载体', 'Generate knowledge artifact')} onCancel={() => { if (!busy) onClose(); }} closable={!busy} maskClosable={false} keyboard={!busy} footer={<Space wrap>
    {draft && !uncertain && <Button disabled={busy} onClick={() => { setDraft(null); setError(''); setStalePreview(false); }}>{t('返回选择', 'Back to selection')}</Button>}
    <Button disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</Button>
    {uncertain ? <Button loading={busy} onClick={() => void readSaved()}>{t('核对已保存版本', 'Check saved version')}</Button> : <Button type="primary" loading={busy} disabled={!loaded || loadingBaseline || stalePreview || mode === 'library' && !baselineLoaded || (draft ? !content.trim() : !name.trim() || selected.length > 100 || (!selected.length && mode !== 'library') || (mode === 'library' && !target) || (mode === 'local' && !path.trim()))} onClick={() => void (draft ? save() : preview())}>{draft ? t('保存载体', 'Save artifact') : t('生成并核对内容', 'Generate and review')}</Button>}
  </Space>}>
    {loadError && <Alert className="knowledge-operation-feedback" type="error" showIcon title={loadError} action={<Button disabled={busy} onClick={() => setLoadRetry(value => value + 1)}>{t('重新读取知识与载体', 'Reload knowledge and artifacts')}</Button>}/>}
    {baselineError && mode === 'library' && <Alert className="knowledge-operation-feedback" type="error" showIcon title={baselineError} action={<Button disabled={busy || loadingBaseline} onClick={() => setBaselineRetry(value => value + 1)}>{t('重新读取已有选择', 'Reload saved selection')}</Button>}/>}
    {error && <Alert className="knowledge-operation-feedback" type="error" showIcon title={error}/>}
    <p>{t('根据已核对的知识组织内容，不额外调用模型。保存不代表内容已证实或效果已通过评测。', 'Organizes reviewed knowledge without another model call. Saving does not verify truth or evaluation performance.')}</p>
    {draft ? <div className="carrier-preview"><p><strong>{draft.name} · {draft.artifactKind}</strong></p><p>{t('保存文件名', 'Save name')}：<code>{draft.directoryName}</code></p><p>{t('保存到所选知识目录的 artifacts 中；已有内容保存为新版本，原始文件保留。', 'Saved under artifacts in the selected knowledge directory. Updates create a new version and preserve the original file.')}</p><CarrierSelectionReview changes={draft.selectionChanges} lang={lang}/><CarrierContentReview content={content} original={draft.baseContent} lang={lang} onChange={setContent} readOnly={busy || uncertain}/></div> : <div className="carrier-selection">
      <label>{t('写入方式', 'Destination')}<Select disabled={busy || loadingBaseline} aria-label={t('写入方式', 'Destination')} value={mode} onChange={value => { setMode(value); setError(''); }} options={[
        { value: 'new', label: t('创建新载体', 'Create artifact') }, { value: 'library', label: t('更新已保存载体', 'Update saved artifact') }, { value: 'local', label: t('基于本地文件生成新版本', 'Create version from local file') },
      ]}/></label>
      {mode === 'library' && <label>{t('已有载体', 'Saved artifact')}<Select disabled={busy || loadingBaseline} aria-label={t('已有载体', 'Saved artifact')} value={target || undefined} options={carriers.filter(row => !row.drifted).map(row => ({ value: row.artifactId, label: `${row.name} · ${row.artifactKind} · v${row.version}` }))} onChange={id => { const row = carriers.find(row => row.artifactId === id)!; setTarget(id); setName(row.name); setKind(row.artifactKind); }}/></label>}
      {mode === 'local' && <label>{t('本地文件路径', 'Local file path')}<Input disabled={busy || loadingBaseline} aria-label={t('本地文件路径', 'Local file path')} value={path} onChange={event => setPath(event.target.value)} placeholder={t('SKILL.md 或 prompt 文件的完整路径', 'Full path to SKILL.md or a prompt file')}/></label>}
      <label>{t('载体名称', 'Artifact name')}<Input disabled={busy || loadingBaseline} aria-label={t('载体名称', 'Artifact name')} maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label>
      <label>{t('载体形式', 'Artifact form')}<Select aria-label={t('载体形式', 'Artifact form')} disabled={busy || loadingBaseline || mode === 'library'} value={kind} onChange={setKind} options={[{ value: 'skill', label: 'skill（SKILL.md）' }, { value: 'prompt', label: 'prompt（Markdown）' }]}/></label>
      {mode === 'library' && baselineReview && <CarrierKnowledgeReviewPanel review={baselineReview} workspace={workspace} lang={lang}/>}
      {mode === 'library' && <p>{t('按本次选择重建知识区：未选知识从新版本移除，已选知识使用当前已保留修订。旧版本、知识区外的手工内容及依赖资产保留。', 'Rebuild from this selection: omitted knowledge is removed from the new version; selected knowledge uses current retained revisions. Old versions, manual content outside the region and assets are preserved.')}</p>}
      <fieldset><legend>{t('选择已保留知识', 'Select retained knowledge')}</legend><p>{t(`已选择 ${selected.length} 条，单次最多 100 条。`, `${selected.length} selected; up to 100 per operation.`)}</p><div className="carrier-knowledge-selection">{!loaded ? busy ? <Spin/> : <p>{t('已保留知识尚不可读，请重新读取。', 'Retained knowledge is not readable yet. Reload.')}</p> : rows.length ? rows.map(row => <Checkbox key={row.knowledgeId} disabled={busy || loadingBaseline || mode === 'library' && !baselineLoaded || !selected.includes(row.knowledgeId) && selected.length >= 100} checked={selected.includes(row.knowledgeId)} onChange={event => setSelected(current => event.target.checked ? [...current, row.knowledgeId] : current.filter(id => id !== row.knowledgeId))}>{row.title}</Checkbox>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('尚无已保留知识。先核对候选并保留。', 'No retained knowledge. Review and retain candidates first.')}/>}</div></fieldset>
    </div>}
  </Modal>;
}
