import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../knowledge/store.js';
import { EntityLinkPreviewSchema, type EntityLinkInvocation } from '../../knowledge/entities/link-invocation.js';
import type { EntityLinkApplication } from '../../knowledge/entity-linking/entity-links.js';
import type { Lang } from '../../shared/language.js';
import type { EntityLinkQuality } from '../../knowledge/entity-linking/entity-link-quality.js';

/** CLI authorization envelope only; the shared host owns the execution protocol. */
const EntityLinkCliPlanBodySchema = z.strictObject({
  responseKind: z.literal('entity-link-cli-plan'), schemaVersion: z.literal(1),
  workspace: z.string().refine(value => isAbsolute(value) && resolve(value) === value, 'Plan workspace must be normalized and absolute.'), preview: EntityLinkPreviewSchema,
});
type PlanBody = z.infer<typeof EntityLinkCliPlanBodySchema>;
// This CLI authorization envelope binds the workspace and complete shared preview, not a host/runtime attestation.
function confirmation(body: PlanBody): string { return `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`; }
export const EntityLinkCliPlanSchema = EntityLinkCliPlanBodySchema.extend({ confirmedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
  .refine(({ confirmedDigest, ...body }) => confirmation(body) === confirmedDigest, 'CLI plan confirmation integrity mismatch.');
export type EntityLinkCliPlan = z.infer<typeof EntityLinkCliPlanSchema>;
export function createEntityLinkCliPlan(workspace: string, preview: PlanBody['preview']): EntityLinkCliPlan {
  const body = EntityLinkCliPlanBodySchema.parse({ responseKind: 'entity-link-cli-plan', schemaVersion: 1, workspace: resolve(workspace), preview });
  return EntityLinkCliPlanSchema.parse({ ...body, confirmedDigest: confirmation(body) });
}
type Projection = ReturnType<EntityLinkApplication['project']>;

export function formatEntityLinkPreview(value: EntityLinkCliPlan, lang: Lang): string {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const { preview, workspace } = value, request = preview.plan.request;
  return [
    `workspace: ${workspace}`, `reviewId: ${preview.reviewId}`, `requestId: ${preview.requestId}`, `startRequestId: ${preview.startRequestId}`,
    `${request.executor} / ${request.model}`, `confirm-input: ${value.confirmedDigest}`,
    t('本次调用额度：1。尚未调用模型；美元费用可能未报告，不是金额硬上限。', 'Invocation budget: 1. No model call yet; USD cost may be unreported, not a spending ceiling.'),
    t('运行上下文（不含凭据）：', 'Runtime context (without credentials):'), JSON.stringify(preview.producerContext, null, 2),
    t('固定规则（实际 system 字节）：', 'Fixed rules (actual system bytes):'), request.system,
    t('选定内容（实际 prompt 字节）：', 'Selected content (actual prompt bytes):'), request.prompt,
    t('仅显示已冻结计划，不代表当前配置仍匹配。保存单次 preview --json 输出后，可用 preview --input 核对同一文件，再以它的 --confirm-input 执行 propose。', 'This displays a frozen plan, not proof that current configuration still matches. Save one preview --json output, inspect it with preview --input, then propose with its --confirm-input.'),
  ].join('\n');
}

export function formatEntityLinkInvocation(history: EntityLinkInvocation, projection: Projection, workspace: string, lang: Lang): string {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const known = (value: number | null) => value === null ? t('未报告／未知', 'unreported/unknown') : String(value);
  const lines = [`workspace: ${workspace}`, `reviewId: ${history.reviewId}`, `generation: ${projection.generation}`, `status: ${projection.status}`,
    `${t('调用额度', 'Invocation budget')}: reserved=${projection.invocationBudget.reserved}, consumed=${projection.invocationBudget.consumed}`,
    `${t('用量', 'Usage')}: input=${known(projection.usage.inputTokens)}, output=${known(projection.usage.outputTokens)}, cache-read=${known(projection.usage.cacheReadTokens)}, USD=${known(projection.usage.costUSD)}`,
    t('接纳结果（模型建议不代表人工同意）：', 'Admission (a model suggestion is not human acceptance):'), JSON.stringify(projection.admission, null, 2)];
  const prepare = history.events[0].command;
  if (prepare.commandKind === 'prepare') lines.push(t('已发送／计划发送的选定内容：', 'Selected content sent/planned:'), prepare.input.request.prompt);
  const recorded = history.events.find(event => event.command.commandKind === 'execution_recorded')?.command;
  if (recorded?.commandKind === 'execution_recorded') lines.push(t('完整执行事实：', 'Complete execution evidence:'), JSON.stringify(recorded.outcome, null, 2));
  lines.push(t('show --json 可导出完整历史。resume 不调用模型；unknown 或确认丢失时先核对本 reviewId。', 'show --json exports complete history. resume never calls a model; inspect this reviewId after unknown acknowledgements.'));
  return lines.join('\n');
}

export function formatEntityLinkQuality(quality: EntityLinkQuality, workspace: string, lang: Lang): string {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const lines = [`workspace: ${workspace}`, quality.projectionVersion,
    t('只读已保存记录；机器接纳与人工选择均不代表准确率。本次零模型调用。', 'Reads saved evidence only. Machine admission and human choices do not measure accuracy. No model invocation.')];
  if (quality.readStatus === 'unreadable') return [...lines, t('关联历史不可读；数量未知，不能据此判断为 0。请核对工作区权限和存储格式后重新读取。', 'Link history is unreadable; its count is unknown, not zero. Inspect workspace permissions and storage format, then reload.')].join('\n');
  lines.push(`${t('持久 review', 'Durable reviews')}: ${quality.reviewCount}; ${t('可比分组', 'Comparison groups')}: ${quality.groups.length}`);
  for (const group of quality.groups) {
    lines.push(JSON.stringify(group.identity),
      `${t('执行分母', 'Invocation denominator')}: ${group.reviews.total}; ${t('已派发', 'dispatched')}=${group.reviews.dispatched}; ${t('未派发', 'not dispatched')}=${group.reviews.notDispatched}; ${t('结果未归档', 'outcome unrecorded')}=${group.reviews.outcomeUnrecorded}`,
      `${t('机器接纳分母', 'Admission denominator')}: ${group.admission.recorded}; admitted=${group.admission.admitted}; rejected=${group.admission.rejected}; ${t('已派发但未知', 'dispatched unknown')}=${group.admission.unrecordedDispatched}`,
      `${t('人工决定分母', 'Human decision denominator')}: ${group.humanDecisions.decided}; accept=${group.humanDecisions.accepted}; reject=${group.humanDecisions.rejected}; ${t('接纳后待定', 'admitted undecided')}=${group.humanDecisions.undecidedAdmitted}`,
      `${t('状态、拒绝原因、三种建议及已知／未知用量', 'States, rejection reasons, three assessments, and known/unknown usage')}: ${JSON.stringify({ states: group.reviews.byStatus, reasons: group.admission.reasons, assessments: group.assessments, executionFailures: group.executionFailures, organization: group.organization, usage: group.usage })}`);
  }
  return lines.join('\n');
}
