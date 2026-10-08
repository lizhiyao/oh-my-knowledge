'use client';
import Link from 'next/link';
import { Button, Input, Select, Space } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeReviewBatch } from '../../../view-models/knowledge/knowledge-candidates';
import { workspaceHref } from '../layout/workspace-link';
import { KNOWLEDGE_INDEX_PATH, MEASURE_INDEX_PATH } from '../../../http/page-paths';

export function CandidateReviewProgress({ batch, lang, busy, previous, onPrevious, onLibrary }: {
  batch: KnowledgeReviewBatch; lang: Language; busy: boolean; previous: boolean; onPrevious(): void; onLibrary(): void;
}) {
  const zh = lang === 'zh';
  return <div className="candidate-batch-progress">
    <span role="status">{zh ? `本次提炼 · 已处理 ${batch.retained + batch.discarded}／${batch.total} 条` : `This extraction · ${batch.retained + batch.discarded}/${batch.total} decided`}
      {batch.missing > 0 && (zh ? ` · ${batch.missing} 条无法读取` : ` · ${batch.missing} unavailable`)}</span>
    <Space wrap>{previous && <Button size="small" disabled={busy} onClick={onPrevious}>{zh ? '回看上一条' : 'Revisit previous item'}</Button>}
      <Button size="small" disabled={busy} onClick={onLibrary}>{zh ? '返回全部知识' : 'All knowledge'}</Button></Space>
  </div>;
}

export function CandidateReviewSummary({ batch, lang, workspace, originHref, busy, onRevisit, onLibrary }: {
  batch: KnowledgeReviewBatch; lang: Language; workspace: string; originHref?: string; busy: boolean; onRevisit(): void; onLibrary(): void;
}) {
  const zh = lang === 'zh';
  return <section className="candidate-batch-summary">
    <h2>{zh ? '本批核对完成' : 'Batch review complete'}</h2>
    <p>{zh ? `已保留 ${batch.retained} 条，已舍弃 ${batch.discarded} 条。` : `${batch.retained} retained, ${batch.discarded} discarded.`}</p>
    <p>{zh ? '决定、理由和历史修订均已保存，可随时回看。' : 'Decisions, reasons and revisions are saved and can be revisited.'}</p>
    {batch.retained > 0 && <><p>{zh ? '保留表示愿意维护，不等于内容已得到证实。用于实际任务前，按适用条件人工整理到 AGENTS.md、skill 或其他载体，再通过受控评测检查改动效果。' : 'Retaining means choosing to maintain this content, not verifying its truth. Before use, review its conditions, manually update AGENTS.md, a skill or another artifact, then evaluate the change in a controlled comparison.'}</p>
      <Space wrap><Link href={workspaceHref(KNOWLEDGE_INDEX_PATH, workspace)}>{zh ? '查看知识载体' : 'View knowledge artifacts'}</Link><Link href={workspaceHref(MEASURE_INDEX_PATH, workspace)}>{zh ? '查看评测记录' : 'View evaluation records'}</Link></Space></>}
    <Space wrap><Button disabled={busy} onClick={onRevisit}>{zh ? '回看最后处理的候选' : 'Revisit the last item'}</Button><Button disabled={busy} onClick={onLibrary}>{zh ? '返回全部知识' : 'All knowledge'}</Button></Space>
    {originHref && <Link href={originHref}>{zh ? '返回来源对话' : 'Back to source conversation'}</Link>}
  </section>;
}

export function CandidateDecisionActions({ lang, reason, busy, needsRefresh, onReason, onEdit, onDecision }: {
  lang: Language; reason: string; busy: boolean; needsRefresh: boolean; onReason(value: string): void; onEdit(): void; onDecision(choice: 'retain' | 'discard'): void;
}) {
  const zh = lang === 'zh';
  const presets = zh ? ['后续处理同类任务时参考，使用前核对适用条件。', '与已有知识重复，暂不采用。', '当前依据不足，暂不采用。']
    : ['Useful for similar tasks; check conditions before use.', 'Duplicates existing knowledge; do not adopt it now.', 'Evidence is insufficient; do not adopt it now.'];
  return <footer className="candidate-actions">
    <label className="candidate-reason">{zh ? '处理理由' : 'Decision reason'}<Input aria-label={zh ? '处理理由' : 'Decision reason'} disabled={busy || needsRefresh} value={reason}
      placeholder={zh ? '填写理由，或选择下方快捷理由后修改' : 'Write a reason, or choose and edit a preset below'} onChange={event => onReason(event.target.value)}/></label>
    <Select className="candidate-reason-presets" aria-label={zh ? '快捷处理理由' : 'Reason presets'} disabled={busy || needsRefresh} value={null}
      placeholder={zh ? '快捷理由（选择后仍需确认决定）' : 'Reason preset (confirm your decision afterwards)'} options={presets.map(value => ({ value, label: value }))} onChange={onReason}/>
    <Space wrap><Button disabled={busy || needsRefresh} onClick={onEdit}>{zh ? '修订' : 'Edit'}</Button>
      <Button type="primary" disabled={busy || needsRefresh || !reason.trim()} onClick={() => onDecision('retain')}>{zh ? '保留' : 'Retain'}</Button>
      <Button disabled={busy || needsRefresh || !reason.trim()} onClick={() => onDecision('discard')}>{zh ? '舍弃' : 'Discard'}</Button></Space>
  </footer>;
}
