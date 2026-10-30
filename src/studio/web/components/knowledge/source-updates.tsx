'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Space } from 'antd';
import type { SourceRef } from '../../../../knowledge/sources';
import type { KnowledgeSourceUpdates, SourceViewSnapshot } from '../../../view-models/knowledge/knowledge-candidates';
import { KNOWLEDGE_LIBRARY_PATH } from '../../../http/page-paths';
import type { Language } from '../layout/shell';
import { workspaceHref } from '../layout/workspace-link';
import { requestKnowledge } from './request';

/** The saved reference owns the check. Optional metadata only enables an explicit Git comparison. */
export function SourceUpdates({ source, snapshot, workspace, lang, busy = false, run }: {
  source: SourceRef; snapshot?: SourceViewSnapshot; workspace?: string; lang: Language; busy?: boolean;
  run?(action: (signal: AbortSignal) => Promise<void>): Promise<void>;
}) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const stateLabels: Record<KnowledgeSourceUpdates['current']['state'], string> = {
    unchanged: t('未变化', 'Unchanged'), content_changed: t('来源内容有变化', 'Source content changed'),
    provenance_only_changed: t('仅来源归因变化', 'Only source attribution changed'), possible_move: t('可能移动，待核对', 'Possible move; review needed'),
    unknown: t('尚不能确定', 'Not yet determined'), deleted: t('文件已删除', 'File deleted'), unavailable: t('当前来源暂不可核对', 'Current source cannot be checked'),
  };
  const saved = snapshot?.snapshotId === source.snapshotId && snapshot.sourceVersion === source.sourceVersion ? snapshot : undefined;
  const context = JSON.stringify([workspace, source.snapshotId, source.sourceVersion, !!saved]);
  const [revision, setRevision] = useState(''), [result, setResult] = useState<{ context: string; report: KnowledgeSourceUpdates; revision?: string }>();
  const [checking, setChecking] = useState(false), [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current?.abort(); active.current = null; setRevision(''); setResult(undefined); setChecking(false); setFailed(false);
    return () => { active.current?.abort(); active.current = null; };
  }, [context]);
  async function check(newRevision?: string) {
    if (busy || active.current || !workspace?.trim()) return;
    if (newRevision !== undefined && (!newRevision.trim() || saved?.sourceKind !== 'git_blob' || !saved.selection.lineRanges.length)) return;
    const controller = new AbortController(); active.current = controller; setChecking(true); setFailed(false); setResult(undefined);
    const ref = { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion };
    const replacementSelection = newRevision && saved?.sourceKind === 'git_blob' ? { sourceKind: saved.sourceKind,
      projectId: saved.identity.projectId, relativePath: saved.identity.relativePath, lineRanges: saved.selection.lineRanges, revision: newRevision } : undefined;
    const read = async (parentSignal?: AbortSignal) => {
      const cancel = () => controller.abort();
      parentSignal?.addEventListener('abort', cancel, { once: true });
      if (parentSignal?.aborted) cancel();
      try {
        const report = await requestKnowledge<KnowledgeSourceUpdates>('sources', { operation: 'source-updates', workspace, source: ref,
          ...(replacementSelection ? { replacementSelection } : {}) }, controller.signal);
        if (report.current.sourceRef.snapshotId !== ref.snapshotId || report.current.sourceRef.sourceVersion !== ref.sourceVersion) throw new Error('Source update reference mismatch.');
        if (!controller.signal.aborted) setResult({ context, report, ...(newRevision ? { revision: newRevision } : {}) });
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { parentSignal?.removeEventListener('abort', cancel); }
    };
    try { await (run ? run(read) : read()); }
    catch { if (!controller.signal.aborted) setFailed(true); }
    finally { if (active.current === controller) { active.current = null; setChecking(false); } }
  }
  const current = result?.context === context ? result : undefined;
  const report = current?.report, disabled = busy || checking || !workspace?.trim();
  const reviewCount = (reviewKind: 'review_body' | 'review_catalog' | 'review_projection') => report?.reviewSuggestions.filter(item => item.reviewKind === reviewKind).length ?? 0;
  const bodyReviews = report?.reviewSuggestions.flatMap(item => item.reviewKind === 'review_body' && item.target.targetKind === 'body'
    ? [{ bodyRef: item.target.bodyRef, reason: item.reason }] : []) ?? [];
  return <section className="candidate-form">
    <h3>{t('来源变化影响', 'Source change impact')}{saved && <> · {saved.sourceKind === 'agent_trace' ? saved.identity.sourceId : `${saved.identity.projectId} / ${saved.identity.relativePath}`}</>}</h3>
    <p>{t('只读取变化与依赖，不调用模型、不改原捕获、正文或发送授权；复核建议不表示知识已更新。', 'Read changes and dependencies without a model call or changes to the capture, content or send approval. Review suggestions do not mean knowledge has been updated.')}</p>
    {!workspace?.trim() && <p>{t('未选择工作区，尚未核对来源变化。', 'No workspace selected; source changes have not been checked.')}</p>}
    <Space wrap><Button disabled={disabled} loading={checking} onClick={() => void check()}>{t('核对该来源的变化影响', 'Check changes affecting this source')}</Button>
      {checking && <Button onClick={() => active.current?.abort()}>{t('取消来源核对', 'Cancel source check')}</Button>}</Space>
    {!saved && <p>{t('尚未取得此精确来源的身份与选区；仍可按已有引用核对，显式 Git 版本比较暂不可用。', 'Identity and selection for this exact source are unavailable. Check its saved reference; explicit Git comparison is unavailable.')}</p>}
    {saved?.sourceKind === 'git_blob' && <>
      <p style={{ overflowWrap: 'anywhere' }}>{t('已捕获提交：', 'Captured commit: ')}<code>{saved.identity.commitOid}</code> · {t('固定行范围：', 'Fixed line ranges: ')}{saved.selection.lineRanges.map(range => `${range.startLine}–${range.endLine}`).join(', ')}</p>
      <p>{t('上方仅核对捕获时固定对象。要对比另一个本地提交或分支，请明确填写；项目、路径及行范围沿用原捕获，不自动选择 HEAD。比较不替换本次已捕获来源或模型输入；要使用新版本，请另行预览并捕获。', 'The check above reopens the captured objects. Explicitly enter another local commit or branch to compare; the original project, path and line ranges stay fixed. HEAD is not selected automatically. Comparing does not replace this capture or model input; to use the new version, preview and capture it separately.')}</p>
      <label>{t('对比 Git 提交或分支', 'Compare Git commit or branch')}<Input value={revision} disabled={disabled || !saved.selection.lineRanges.length} onChange={event => { setRevision(event.target.value); setResult(undefined); setFailed(false); }}/></label>
      <Button disabled={disabled || !revision.trim() || !saved.selection.lineRanges.length} onClick={() => void check(revision.trim())}>{t('对比版本并核对影响', 'Compare revision and check impact')}</Button>
      {!saved.selection.lineRanges.length && <p>{t('该捕获没有可比较的行范围。', 'This capture has no line range to compare.')}</p>}
    </>}
    {failed && <Alert type="error" title={t('无法核对来源变化。请检查提交或分支、来源配置后重试。', 'Could not check source changes. Check the revision and source configuration, then retry.')}/>}
    {report && <><p>{t('来源状态：', 'Source state: ')}{stateLabels[report.current.state]} · {report.current.checkedAt}</p>
      {current?.revision && <p style={{ overflowWrap: 'anywhere' }}>{t('本次对比 Git 版本：', 'Compared Git revision: ')}{current.revision}</p>}
      {report.current.observedIdentity?.sourceKind === 'git_blob' && <p style={{ overflowWrap: 'anywhere' }}>{t('实际核对提交：', 'Resolved comparison commit: ')}<code>{report.current.observedIdentity.commitOid}</code></p>}
      <p>{t(`已知引用：正文版本 ${report.affectedExactBodyRefs.length} 个 · 实体目录版本 ${report.catalogRefs.length} 个 · 关联版本 ${report.projectionRefs.length} 个。`, `Known references: ${report.affectedExactBodyRefs.length} body versions · ${report.catalogRefs.length} entity catalog versions · ${report.projectionRefs.length} association versions.`)}</p>
      <p>{t(`需要核对：正文版本 ${reviewCount('review_body')} 个 · 实体目录版本 ${reviewCount('review_catalog')} 个 · 关联版本 ${reviewCount('review_projection')} 个；不表示语义已核实。`, `Review needed: ${reviewCount('review_body')} body versions · ${reviewCount('review_catalog')} entity catalog versions · ${reviewCount('review_projection')} association versions; semantic validity is not established.`)}</p>
      {(report.inventoryCompleteness !== 'complete' || report.impactCompleteness !== 'complete') && <Alert type="warning" title={t('影响清单尚未完整，不能据此判断没有影响。', 'The impact inventory is incomplete; absence of impact cannot be inferred.')}/>}
      {workspace && bodyReviews.length > 0 && <ol>{bodyReviews.map(({ bodyRef, reason }, index) => <li key={JSON.stringify(bodyRef)}>
        <a href={workspaceHref(`${KNOWLEDGE_LIBRARY_PATH}?${new URLSearchParams({ knowledge: bodyRef.knowledgeId, revision: bodyRef.revisionId })}`, workspace)}
          aria-label={t(`核对受影响知识（第 ${index + 1} 项）`, `Review affected knowledge (item ${index + 1})`)}>{t('核对受影响知识', 'Review affected knowledge')}</a>
        <details><summary>{t('修订详情', 'Revision details')}</summary>
          <p>{t('知识：', 'Knowledge: ')}<code>{bodyRef.knowledgeId}</code></p><p>{t('修订：', 'Revision: ')}<code>{bodyRef.revisionId}</code></p><p>{reason}</p>
        </details>
      </li>)}</ol>}
      {[...report.current.limitations, ...report.impactLimitations].map((limitation, index) => <p key={index}>{limitation}</p>)}
      <details><summary>{t('影响与复核建议', 'Impact and review suggestions')}</summary><pre style={{ maxHeight: '28vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(report, null, 2)}</pre></details></>}
  </section>;
}
