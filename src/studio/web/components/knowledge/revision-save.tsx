'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from 'antd';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { Language } from '../layout/shell';
import { KnowledgeRequestError, requestKnowledge } from './request';
import { useKnowledgeSave } from './save-session';

/** Revision operations have no client receipt identity: read back for inspection, never infer success or resend. */
export function useRevisionSave(workspace: string, detail: KnowledgeCandidateDetail, lang: Language) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const { session, state, busy, uncertain } = useKnowledgeSave<Record<string, unknown>>(`${workspace}:${detail.revision.knowledgeId}:${detail.revision.revisionId}`);
  const [conflicted, setConflicted] = useState(false);
  const [latest, setLatest] = useState<KnowledgeCandidateDetail>();
  const [reading, setReading] = useState(false); const [readError, setReadError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, [workspace, detail.revision.revisionId]);
  async function save(operation: 'revise' | 'apply-entities', fields: Record<string, unknown>) {
    if (conflicted || reading) return;
    return session.save({ operation, ...fields }, (command, signal) => requestKnowledge<KnowledgeCandidateDetail>('candidates', { workspace, ...command }, signal), cause => {
      if (!(cause instanceof KnowledgeRequestError) || !cause.definiteRejection) return;
      if (cause.message === 'knowledge_conflict') { setConflicted(true); return t('知识已有更新，草稿已保留。先核对最新修订，再关闭草稿重新编辑；不会再次提交过期草稿。', 'Knowledge changed; your draft is preserved. Check the latest revision, then close this draft and reopen it to edit. The outdated draft will not be submitted again.'); }
      if (cause.message === 'knowledge_citations_invalid') return t('引文无效，请核对来源、原文及出现序号。草稿已保留。', 'Invalid citations. Check the source, exact quotation and occurrence. Your draft is preserved.');
      if (cause.message === 'knowledge_workspace_busy') return t('知识目录正在写入，草稿尚未保存。稍后可重试。', 'The knowledge directory is busy; your draft was not saved. Try again shortly.');
      if (cause.message === 'knowledge_storage_unsupported') return t('数据格式不受支持，草稿未保存。请核对知识目录。', 'Unsupported data format; your draft was not saved. Check the knowledge directory.');
      if (cause.message === 'knowledge_capacity_exceeded' || cause.message === 'request_body_too_large') return t('超出输入或保存上限，草稿未保存。请缩小内容后重试。', 'Input or storage capacity exceeded; your draft was not saved. Reduce the content before retrying.');
    }, t('保存结果未知，草稿已保留并停止重提。请先核对最新知识与修订历史；不要重复保存。', 'Save outcome unknown. Your draft is preserved and resubmission is blocked. Check the latest knowledge and revision history before saving again.'));
  }
  async function inspect() {
    if (controller.current || busy) return;
    const active = new AbortController(); controller.current = active; setReading(true); setReadError('');
    try { const value = await requestKnowledge<KnowledgeCandidateDetail>('candidates', { workspace, operation: 'show', id: detail.revision.knowledgeId }, active.signal);
      if (!active.signal.aborted) setLatest(value);
    } catch { if (!active.signal.aborted) setReadError(t('最新知识尚不可读，草稿仍保留。可以重新读取，不会再次保存。', 'The latest knowledge could not be read. Your draft remains available. Retry reading; no save is repeated.')); }
    finally { if (controller.current === active) { controller.current = null; setReading(false); } }
  }
  return { save, inspect, latest, reading, readError, error: state.error, recovery: conflicted || uncertain,
    busy: busy || reading, locked: busy || reading || conflicted || uncertain };
}

export function RevisionSaveFeedback({ save, lang, onOpenLatest }: {
  save: ReturnType<typeof useRevisionSave>; lang: Language; onOpenLatest(value: KnowledgeCandidateDetail): void;
}) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <>{(save.error || save.readError) && <Alert className="knowledge-operation-feedback" type="error" showIcon title={save.readError || save.error}
    action={save.recovery ? <Button loading={save.reading} disabled={save.busy} onClick={() => void save.inspect()}>{t('核对最新知识（只读）', 'Check latest knowledge (read-only)')}</Button> : undefined}/>}
    {save.latest && <section className="candidate-form candidate-statement"><h3>{t('已读取最新修订', 'Latest revision loaded')}</h3>
      <p>{save.latest.revision.title}</p><p className="candidate-help">{save.latest.revision.revisionId} · {save.latest.revision.revisionReason}</p>
      <p>{t('这次只读取了知识，不确认先前保存是否成功，也没有重新提交。关闭草稿后可核对该修订的正文、引文与历史。', 'This only reads knowledge; it does not confirm the previous save or resubmit it. Close this draft to inspect the revision’s content, citations and history.')}</p>
      <Button disabled={save.busy} onClick={() => onOpenLatest(save.latest!)}>{t('关闭草稿并查看此修订', 'Close draft and inspect this revision')}</Button>
    </section>}
  </>;
}
