import { useEffect, useRef, useState } from 'react';
import type { KnowledgeRelationStatus, KnowledgeRelationReceipt, KnowledgeRelationProposeInput, KnowledgeRelationReviewInput, KnowledgeRelationWithdrawInput } from '../../../view-models/knowledge/knowledge-relations';
import type { Language } from '../layout/shell';
import { KnowledgeRequestError, requestKnowledge } from './request';
import { useKnowledgeSave } from './save-session';

type RelationCommand = ({ operation: 'propose-relation' } & KnowledgeRelationProposeInput)
  | ({ operation: 'review-relation' } & KnowledgeRelationReviewInput) | ({ operation: 'withdraw-relation' } & KnowledgeRelationWithdrawInput);

function comparable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(comparable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${comparable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function receiptFor(status: KnowledgeRelationStatus, command: RelationCommand) {
  if (status.storageStatus !== 'available' || status.relationId !== command.relationId) return;
  const receipt = status.history.receipts.find(value => value.requestId === command.requestId && value.committedGeneration === command.expectedGeneration + 1);
  const event = status.history.events.find(value => value.eventId === receipt?.eventId);
  const eventKind = command.operation === 'propose-relation' ? 'relation_proposed' : command.operation === 'review-relation' ? 'relation_reviewed' : 'relation_withdrawn';
  if (!receipt || !event || event.eventKind !== eventKind || event.parentEventId !== command.expectedHeadEventId || !/^sha256:[a-f0-9]{64}$/.test(receipt.commandDigest)) return;
  const protocol = new Set(['operation', 'relationId', 'requestId', 'expectedGeneration', 'expectedHeadEventId']);
  if (Object.entries(command).some(([key, value]) => !protocol.has(key) && comparable((event as unknown as Record<string, unknown>)[key]) !== comparable(value))) return;
  return receipt;
}

/** Freeze a single command; an unreadable acknowledgement permits only receipt inspection. */
export function useRelationSave(workspace: string, scope: string, lang: Language) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const save = useKnowledgeSave<RelationCommand>(`${workspace}:${scope}`);
  const [conflicted, setConflicted] = useState(false), [receipt, setReceipt] = useState<KnowledgeRelationReceipt>();
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function inspect() {
    const result = await save.session.inspect((command, signal) => requestKnowledge<KnowledgeRelationStatus>('relations', { workspace, operation: 'relation', relationId: command.relationId }, signal),
      (status, command) => !!receiptFor(status, command),
      t('尚未找到与本次请求及内容一致的回执。草稿仍锁定，可再次只读核对。', 'No receipt matches this exact request and content. The draft stays locked; you can check again.'),
      t('回执暂不可读。草稿仍锁定；只读核对不会重新提交。', 'The receipt cannot be read. The draft stays locked; checking does not resend the write.'));
    if (result?.current() && alive.current) {
      const state = save.session.getSnapshot();
      if (state.phase === 'saved') setReceipt(receiptFor(result.value, state.command));
    }
    return result;
  }
  async function submit(command: RelationCommand) {
    if (conflicted) return;
    const frozen = JSON.parse(JSON.stringify(command)) as RelationCommand;
    const result = await save.session.save(frozen, async (value, signal) => {
      const received = await requestKnowledge<KnowledgeRelationReceipt>('relations', { workspace, ...value }, signal);
      if (received.requestId !== value.requestId || received.eventId !== value.requestId || received.committedGeneration !== value.expectedGeneration + 1
        || !/^sha256:[a-f0-9]{64}$/.test(received.commandDigest)) throw new Error('Unconfirmed relation receipt.');
      return received;
    }, cause => {
      if (!(cause instanceof KnowledgeRequestError) || !cause.definiteRejection) return;
      if (cause.message === 'knowledge_conflict') {
        setConflicted(true);
        return t('关系记录已有更新。草稿与原基线保留，请先核对记录后重新开始。', 'The relation history changed. Your draft and baseline remain; inspect the history before starting again.');
      }
      return t('这次保存被明确拒绝。草稿保留，请核对条件、依据与操作权限。', 'This save was explicitly rejected. Your draft remains; check the scope, evidence and permissions.');
    }, t('保存结果未知。草稿已锁定，正在只读核对原请求回执，不会自动重发。', 'Save outcome unknown. The draft is locked. Checking the original receipt does not resend the write.'));
    if (result?.current() && alive.current) setReceipt(result.value);
    if (!result && alive.current && save.session.getSnapshot().phase === 'unknown') return inspect();
    return result;
  }
  return { submit, inspect, receipt, error: save.state.error, unknown: save.uncertain, conflicted,
    locked: save.busy || save.uncertain || conflicted, busy: save.state.phase === 'saving' || save.state.phase === 'checking' };
}
