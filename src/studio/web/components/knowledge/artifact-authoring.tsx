'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Checkbox, Empty, Input, Modal, Select, Space, Tabs } from 'antd';
import type { Language } from '../layout/shell';
import type { AuthoredArtifactKind, CarrierDetail, CarrierDraft, CarrierRow, CarrierSource } from '../../../view-models/knowledge/artifact-authoring';
import type { KnowledgeCandidateRow } from '../../../view-models/knowledge/knowledge-candidates';
import { KNOWLEDGE_INDEX_PATH } from '../../../http/page-paths';
import { workspaceHref } from '../layout/workspace-link';

export async function requestArtifact<T>(workspace: string, operation: string, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/knowledge/artifacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, operation, ...fields }), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'carrier_request_failed');
  return result as T;
}
export function CarrierContentReview({ content, original, lang, onChange }: { content: string; original: string; lang: Language; onChange(value: string): void }) {
  const zh = lang === 'zh';
  return <Tabs className="carrier-review-tabs" items={[
    { key: 'content', label: zh ? '核对并编辑新内容' : 'Review and edit new content', children: <Input.TextArea className="carrier-editor" aria-label={zh ? '载体内容' : 'Artifact content'} value={content} onChange={event => onChange(event.target.value)}/> },
    ...(original ? [{ key: 'original', label: zh ? '原内容' : 'Original content', children: <pre className="carrier-original">{original}</pre> }] : []),
  ]}/>;
}

export function ArtifactAuthoringDialog({ workspace, lang, ids = [], existing, onClose, onSaved }: {
  workspace: string; lang: Language; ids?: string[]; existing?: CarrierRow; onClose(): void; onSaved?(detail: CarrierDetail): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const router = useRouter();
  const [rows, setRows] = useState<KnowledgeCandidateRow[]>([]);
  const [carriers, setCarriers] = useState<CarrierRow[]>([]);
  const [selected, setSelected] = useState(ids);
  const [mode, setMode] = useState<'new' | 'library' | 'local'>(existing ? 'library' : 'new');
  const [target, setTarget] = useState(existing?.artifactId ?? '');
  const [path, setPath] = useState('');
  const [kind, setKind] = useState<AuthoredArtifactKind>(existing?.artifactKind ?? 'skill');
  const [name, setName] = useState(existing?.name ?? '');
  const [draft, setDraft] = useState<CarrierDraft | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch('/api/knowledge/candidates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, operation: 'list' }), signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(); return await response.json() as KnowledgeCandidateRow[]; }),
      requestArtifact<CarrierRow[]>(workspace, 'list', {}, controller.signal),
    ]).then(([knowledge, artifacts]) => { setRows(knowledge.filter(row => row.choice === 'retain')); setCarriers(artifacts); })
      .catch(() => { if (!controller.signal.aborted) setError(t('未能读取知识或载体，请关闭后重新打开。', 'Could not load knowledge or artifacts. Close and reopen.')); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [workspace]);
  const source: CarrierSource = mode === 'new' ? { sourceKind: 'new' } : mode === 'library' ? { sourceKind: 'library', artifactId: target } : { sourceKind: 'local', path };
  const failure = (cause: unknown) => cause instanceof Error && cause.message === 'carrier_source_contains_destination' ? t('本地 skill 目录包含当前保存目录，不能复制到自身内部。请选择其它知识保存目录后再生成。', 'The local skill contains the save directory and cannot be copied into itself. Choose another knowledge directory before generating.') : cause instanceof Error && cause.message === 'carrier_invalid_skill' ? t('skill 需保留有效头部，name 应与下方保存目录名一致，并填写 description。请编辑后再保存。', 'Keep valid skill frontmatter: name must match the save directory below, with a nonempty description. Edit and save again.') : cause instanceof Error && cause.message === 'carrier_conflict'
    ? t('知识或载体已发生变化，请返回选择并重新生成预览。', 'Knowledge or artifact changed. Return to selection and generate a new preview.')
    : t('操作未完成。请检查选择、文件路径或内容大小。', 'Operation failed. Check your selections, file path or content size.');
  const finish = (detail: CarrierDetail) => { onSaved?.(detail); onClose(); router.push(workspaceHref(`${KNOWLEDGE_INDEX_PATH}?artifact=${encodeURIComponent(detail.artifactId)}`, workspace)); };
  async function preview() {
    setBusy(true); setError('');
    try { const next = await requestArtifact<CarrierDraft>(workspace, 'preview', { source, artifactKind: kind, name, ids: selected }); setDraft(next); setContent(next.content); }
    catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  }
  async function save() {
    if (!draft || uncertain) return;
    setBusy(true); setError('');
    try { finish(await requestArtifact<CarrierDetail>(workspace, 'save', { artifactId: draft.artifactId, source: draft.source, artifactKind: draft.artifactKind, name: draft.name, directoryName: draft.directoryName, baselineRevisionId: draft.baselineRevisionId, baselineHash: draft.baselineHash, content, selectedRefs: draft.selectedRefs })); }
    catch (cause) {
      if (cause instanceof Error && ['carrier_conflict', 'carrier_capacity_exceeded', 'request_body_too_large', 'carrier_invalid_skill', 'carrier_source_contains_destination'].includes(cause.message)) setError(failure(cause));
      else { setUncertain(true); setError(t('保存结果未能读取，请先核对已保存版本。', 'Save result could not be read. Check the saved version first.')); }
    } finally { setBusy(false); }
  }
  async function readSaved() {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await requestArtifact<CarrierDetail>(workspace, 'show', { id: draft.artifactId });
      if (!saved.drifted && saved.content === content && draft.selectedRefs.every(ref => saved.knowledgeRefs.some(item => item.knowledgeId === ref.knowledgeId && item.revisionId === ref.revisionId && item.generation === ref.generation)) && (saved.baseline?.contentHash === draft.baselineHash && saved.baseline.revisionId === draft.baselineRevisionId || draft.baselineHash === null && saved.version === 1)) finish(saved);
      else setError(t('未能确认本次内容已保存。关闭后查看载体，再重新生成预览。', 'Could not confirm this save. Close, inspect the artifact, then generate a new preview.'));
    } catch { setError(t('未能确认保存结果。请稍后再次核对。', 'Could not confirm the save. Check again later.')); }
    finally { setBusy(false); }
  }
  return <Modal open width={900} className="carrier-authoring-modal" title={t('生成知识载体', 'Generate knowledge artifact')} onCancel={() => { if (!busy) onClose(); }} closable={!busy} maskClosable={false} keyboard={!busy} footer={<Space wrap>
    {draft && !uncertain && <Button disabled={busy} onClick={() => { setDraft(null); setError(''); }}>{t('返回选择', 'Back to selection')}</Button>}
    <Button disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</Button>
    {uncertain ? <Button loading={busy} onClick={() => void readSaved()}>{t('核对已保存版本', 'Check saved version')}</Button> : <Button type="primary" loading={busy} disabled={draft ? !content.trim() : !name.trim() || selected.length > 100 || (!selected.length && mode !== 'library') || (mode === 'library' && !target) || (mode === 'local' && !path.trim())} onClick={() => void (draft ? save() : preview())}>{draft ? t('保存载体', 'Save artifact') : t('生成并核对内容', 'Generate and review')}</Button>}
  </Space>}>
    {error && <Alert type="error" showIcon title={error}/>}
    <p>{t('根据已核对的知识组织内容，不额外调用模型。保存不代表内容已证实或效果已通过评测。', 'Organizes reviewed knowledge without another model call. Saving does not verify truth or evaluation performance.')}</p>
    {draft ? <div className="carrier-preview"><p><strong>{draft.name} · {draft.artifactKind}</strong></p><p>{t('保存文件名', 'Save name')}：<code>{draft.directoryName}</code></p><p>{t('保存到所选知识目录的 artifacts 中；已有内容保存为新版本，原始文件保留。', 'Saved under artifacts in the selected knowledge directory. Updates create a new version and preserve the original file.')}</p><CarrierContentReview content={content} original={draft.baseContent} lang={lang} onChange={setContent}/></div> : <div className="carrier-selection">
      <label>{t('写入方式', 'Destination')}<Select aria-label={t('写入方式', 'Destination')} value={mode} onChange={value => { setMode(value); setError(''); }} options={[
        { value: 'new', label: t('创建新载体', 'Create artifact') }, { value: 'library', label: t('更新已保存载体', 'Update saved artifact') }, { value: 'local', label: t('基于本地文件生成新版本', 'Create version from local file') },
      ]}/></label>
      {mode === 'library' && <label>{t('已有载体', 'Saved artifact')}<Select aria-label={t('已有载体', 'Saved artifact')} value={target || undefined} options={carriers.filter(row => !row.drifted).map(row => ({ value: row.artifactId, label: `${row.name} · ${row.artifactKind} · v${row.version}` }))} onChange={id => { const row = carriers.find(row => row.artifactId === id)!; setTarget(id); setName(row.name); setKind(row.artifactKind); }}/></label>}
      {mode === 'local' && <label>{t('本地文件路径', 'Local file path')}<Input aria-label={t('本地文件路径', 'Local file path')} value={path} onChange={event => setPath(event.target.value)} placeholder={t('SKILL.md 或 prompt 文件的完整路径', 'Full path to SKILL.md or a prompt file')}/></label>}
      <label>{t('载体名称', 'Artifact name')}<Input aria-label={t('载体名称', 'Artifact name')} maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label>
      <label>{t('载体形式', 'Artifact form')}<Select aria-label={t('载体形式', 'Artifact form')} disabled={mode === 'library'} value={kind} onChange={setKind} options={[{ value: 'skill', label: 'skill（SKILL.md）' }, { value: 'prompt', label: 'prompt（Markdown）' }]}/></label>
      <fieldset><legend>{t('选择已保留知识', 'Select retained knowledge')}</legend><p>{t(`已选择 ${selected.length} 条，单次最多 100 条。`, `${selected.length} selected; up to 100 per operation.`)}</p><div className="carrier-knowledge-selection">{rows.length ? rows.map(row => <Checkbox key={row.knowledgeId} disabled={busy || !selected.includes(row.knowledgeId) && selected.length >= 100} checked={selected.includes(row.knowledgeId)} onChange={event => setSelected(current => event.target.checked ? [...current, row.knowledgeId] : current.filter(id => id !== row.knowledgeId))}>{row.title}</Checkbox>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('尚无已保留知识。先核对候选并保留。', 'No retained knowledge. Review and retain candidates first.')}/>}</div></fieldset>
    </div>}
  </Modal>;
}
