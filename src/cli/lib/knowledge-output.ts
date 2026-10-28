import type { KnowledgeApplication } from '../../knowledge/application/application.js';
import type { KnowledgeOperation } from '../../knowledge/application/operations.js';
import { shellQuoteArg } from '../../shared/shell-quote.js';

/** Every copyable next step carries the same explicit workspace. */
export function knowledgeCommand(workspace: string, operation: string, fields: Record<string, string | number | boolean> = {}): string {
  return ['omk observe knowledge', operation, '--workspace', shellQuoteArg(workspace), ...Object.entries(fields).flatMap(([key, value]) =>
    typeof value === 'boolean' ? value ? [`--${key}`] : [] : [`--${key}`, shellQuoteArg(String(value))])].join(' ');
}
export function formatKnowledgeResult(value: unknown, lang: 'zh' | 'en', operation: KnowledgeOperation, workspace: string): string {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const lines: string[] = [];
  if ('journal' in item) {
    const result = value as ReturnType<KnowledgeApplication['resume']>, journal = result.journal;
    lines.push(`${journal.runId} · ${journal.status} · ${journal.executor}/${journal.model}`,
      t(`已保存 ${journal.bodies.length} 条完整正文；所有新修订仍为 pending，关联和正文维护独立。`, `${journal.bodies.length} complete bodies saved; new revisions are pending, with independent association and body review.`),
      ...journal.stages.map(s => `${s.stageKind}: ${s.state} · ${s.invocationId} · ${s.outcomeRef?.digest ?? 'archive pending'}${s.issues.length ? `\n${s.issues.join('\n')}` : ''}`),
      `nextAction: ${result.nextAction}`, knowledgeCommand(workspace, 'inspect', { id: journal.runId, json: true }));
    if (result.nextAction === 'continue_stage') lines.push(t('仅显式 continue-stage 可发送尚未 claim 的阶段；resume 永不调用模型。', 'Only explicit continue-stage may dispatch a never-claimed phase; resume never calls a model.'),
      knowledgeCommand(workspace, 'continue-stage', { id: journal.runId, generation: journal.generation }));
    if (result.nextAction === 'outcome_unknown_do_not_redispatch') lines.push(t('已 claim 但没有可读原件；发送/费用未知，禁止自动重发。', 'Claimed without a readable original; dispatch/cost unknown, do not redispatch.'));
  } else if ('revision' in item && 'derivedAssociations' in item) {
    const detail = value as ReturnType<KnowledgeApplication['detail']>;
    lines.push(detail.revision.title, `${detail.revision.knowledgeId}/${detail.revision.revisionId}\n${detail.revision.bodyDigest}`,
      ...detail.revision.content.segments.map(s => `[${s.segmentId}] ${s.text}\n${JSON.stringify(s.evidence, null, 2)}`),
      t(`正文维护：${detail.maintenance?.choice ?? 'pending'}；派生：${detail.derivedAssociations.status}。均不证明真值。`, `Body maintenance: ${detail.maintenance?.choice ?? 'pending'}; derived: ${detail.derivedAssociations.status}. Neither verifies truth.`),
      JSON.stringify({ sources: detail.sources, derivedAssociations: detail.derivedAssociations }, null, 2));
  } else lines.push(JSON.stringify(value, null, 2));
  if (operation.operation === 'capture') lines.push(knowledgeCommand(workspace, 'source', { snapshot: String(item.snapshotId) }), knowledgeCommand(workspace, 'generate', { snapshot: String(item.snapshotId) }));
  return [...lines, `${t('知识工作区', 'Knowledge workspace')}: ${workspace}`].join('\n\n');
}
