import { useEffect, useRef, useState } from 'react';
import type { KnowledgeCandidateDetail } from '../../../view-models/knowledge/knowledge-candidates';
import type { KnowledgeReviewContentInput, KnowledgeReviewCoverageInput, KnowledgeReviewUseInput, KnowledgeReviewStatus, KnowledgeReviewReceipt } from '../../../view-models/knowledge/knowledge-reviews';
import { requestKnowledge, KnowledgeRequestError } from './request';
import { useKnowledgeSave } from './save-session';
import type { Language } from '../layout/shell';

type BodyRef = KnowledgeReviewStatus['bodyRef'];
type Command = ({ operation: 'review-content' } & KnowledgeReviewContentInput)
  | ({ operation: 'review-coverage' } & KnowledgeReviewCoverageInput) | ({ operation: 'record-use' } & KnowledgeReviewUseInput);

export function reviewBodyRef(detail: KnowledgeCandidateDetail): BodyRef {
  const { knowledgeId, revisionId, bodyDigest } = detail.revision; return { knowledgeId, revisionId, bodyDigest };
}
export function reviewProjectionRef(detail: KnowledgeCandidateDetail): string | null | undefined {
  const derived = detail.derivedAssociations, ref = derived.revision?.bodyRef, body = detail.revision;
  if (derived.status === 'failed' && !derived.revision) return undefined;
  return ref && ref.knowledgeId === body.knowledgeId && ref.revisionId === body.revisionId && ref.bodyDigest === body.bodyDigest ? derived.revision!.revisionId : null;
}
function sameBody(left: BodyRef, right: BodyRef) { return left.knowledgeId === right.knowledgeId && left.revisionId === right.revisionId && left.bodyDigest === right.bodyDigest; }
async function readStatus(workspace: string, bodyRef: BodyRef, projectionRevisionId: string | null | undefined, signal: AbortSignal) {
  const value = await requestKnowledge<KnowledgeReviewStatus>('reviews', { workspace, operation: 'review-status', bodyRef,
    ...(projectionRevisionId !== undefined ? { projectionRevisionId } : {}) }, signal);
  if (!value?.bodyRef || !sameBody(value.bodyRef, bodyRef)) throw new Error('Review response identity mismatch.');
  return value;
}
/** Review reads are independent: a broken ledger never removes the canonical body. */
export function useKnowledgeReviewStatus(workspace: string | undefined, bodyRef: BodyRef, projectionRevisionId: string | null | undefined) {
  const context = JSON.stringify([workspace, bodyRef.knowledgeId, bodyRef.revisionId, bodyRef.bodyDigest, typeof projectionRevisionId, projectionRevisionId]);
  const [read, setRead] = useState<{ context: string; status?: KnowledgeReviewStatus; loading: boolean; failed: boolean }>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === workspace) setVersion(value => value + 1); };
    window.addEventListener('omk-knowledge-changed', changed); return () => window.removeEventListener('omk-knowledge-changed', changed);
  }, [workspace]);
  useEffect(() => {
    if (!workspace) { setRead({ context, loading: false, failed: false }); return; }
    const controller = new AbortController(); setRead({ context, loading: true, failed: false });
    void readStatus(workspace, bodyRef, projectionRevisionId, controller.signal).then(status => { if (!controller.signal.aborted) setRead({ context, status, loading: false, failed: false }); })
      .catch(() => { if (!controller.signal.aborted) setRead({ context, loading: false, failed: true }); });
    return () => controller.abort();
  }, [context, version]);
  const current = read?.context === context ? read : { loading: !!workspace, failed: false };
  return { status: 'status' in current ? current.status : undefined, loading: current.loading, failed: current.failed, reload: () => setVersion(value => value + 1) };
}

function comparable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(comparable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${comparable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function normalizeCommand(input: Command): Command {
  const evidence = (values: NonNullable<KnowledgeReviewUseInput['evidence']> = []) => values.map(value => structuredClone(value));
  const common = { ...input, reason: input.reason.trim(), supersedesEventIds: input.supersedesEventIds ?? [] };
  if (input.operation === 'review-content') return { ...common, operation: input.operation, status: input.status,
    limitations: input.limitations.map(value => value.trim()), findings: input.findings.map(finding => ({ ...finding, description: finding.description.trim(), evidence: evidence(finding.evidence) })) };
  if (input.operation === 'review-coverage') return { ...common, operation: input.operation, projectionRevisionId: input.projectionRevisionId,
    decisions: input.decisions.map(decision => ({ ...decision, reason: decision.reason.trim(), entityRefs: decision.entityRefs ?? [] })) };
  return { ...common, operation: input.operation, taskRef: input.taskRef.trim(), query: input.query.trim(), segmentIds: input.segmentIds, signal: input.signal,
    evidenceRefs: (input.evidenceRefs ?? []).map(value => value.trim()), evidence: evidence(input.evidence) };
}
/** An acknowledgement must identify this exact command's event, not just a shared request ID. */
function receiptFor(status: KnowledgeReviewStatus, command: Command) {
  const receipt = status.history?.receipts.find(item => item.requestId === command.requestId && item.committedGeneration === command.expectedGeneration + 1);
  const event = status.history?.events.find(item => item.eventId === receipt?.eventId);
  if (!receipt || !event || event.parentEventId !== command.expectedHeadEventId || !/^sha256:[a-f0-9]{64}$/.test(receipt.commandDigest) || !sameBody(event.bodyRef, command.bodyRef)) return;
  const eventKind = command.operation === 'review-content' ? 'content_review' : command.operation === 'review-coverage' ? 'association_coverage' : 'task_use';
  if (event.eventKind !== eventKind) return;
  const protocolKeys = new Set(['operation', 'requestId', 'expectedGeneration', 'expectedHeadEventId']);
  if (Object.entries(command).some(([key, value]) => !protocolKeys.has(key) && comparable((event as unknown as Record<string, unknown>)[key]) !== comparable(value))) return;
  return receipt;
}
export function useKnowledgeReviewSave(workspace: string, bodyRef: BodyRef, projectionRevisionId: string | null | undefined, lang: Language) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const save = useKnowledgeSave<Command>(`${workspace}:${bodyRef.knowledgeId}:${bodyRef.revisionId}:${bodyRef.bodyDigest}`);
  const [conflicted, setConflicted] = useState(false), [receipt, setReceipt] = useState<KnowledgeReviewReceipt>();
  const [checked, setChecked] = useState<KnowledgeReviewStatus>();
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function submit(command: Command) {
    if (conflicted) return;
    const frozen = JSON.parse(JSON.stringify(normalizeCommand(command))) as Command;
    const result = await save.session.save(frozen, async (value, signal) => {
      const received = await requestKnowledge<KnowledgeReviewReceipt>('reviews', { workspace, ...value }, signal);
      if (received.requestId !== value.requestId || received.committedGeneration !== value.expectedGeneration + 1 || !received.eventId || !/^sha256:[a-f0-9]{64}$/.test(received.commandDigest)) throw new Error('Unconfirmed review receipt.');
      return received;
    }, cause => {
      if (!(cause instanceof KnowledgeRequestError) || !cause.definiteRejection) return;
      if (cause.message === 'knowledge_conflict') { setConflicted(true); return t('复核记录已有更新。草稿与旧基线已保留；先核对记录，关闭后重新开始，不会重发。', 'Review history changed. Your draft and original baseline are preserved. Check the history, then close and reopen; no resubmission occurs.'); }
      return t('这次保存已明确拒绝，草稿保留。请核对输入、精确依据或目录状态后再保存。', 'This save was explicitly rejected. Your draft remains. Check the input, exact evidence or workspace before saving again.');
    }, t('保存结果未知。草稿已锁定；先按请求回执核对已保存事件，不会自动重发。', 'Save outcome unknown. Your draft is locked. Check the request receipt against saved events; no automatic retry occurs.'));
    if (result?.current() && alive.current) setReceipt(result.value);
    if (!result && alive.current && save.session.getSnapshot().phase === 'unknown') await inspect();
    return result;
  }
  async function inspect() {
    const state = save.session.getSnapshot(); if (state.phase !== 'unknown') return;
    const command = state.command;
    const result = await save.session.inspect((command, signal) => readStatus(workspace, command.bodyRef, projectionRevisionId, signal), (value, command) => !!receiptFor(value, command),
      t('尚未找到与本次请求和内容一致的回执。草稿仍锁定；未确认保存，也未重新提交。', 'No receipt matching this request and content was found. The draft remains locked; saving is unconfirmed and no request was resubmitted.'),
      t('回执暂不可读。草稿仍锁定；可以再次只读核对，不会重发保存。', 'The receipt could not be read. Your draft remains locked. Retry the read-only check; the save will not be resent.'));
    if (result?.current() && alive.current) { setChecked(result.value); setReceipt(receiptFor(result.value, command)); }
    return result;
  }
  return { submit, inspect, receipt, checked, error: save.state.error, unknown: save.uncertain, busy: save.state.phase === 'saving' || save.state.phase === 'checking',
    locked: save.busy || save.uncertain || conflicted, conflicted };
}
