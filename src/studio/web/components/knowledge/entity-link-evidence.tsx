'use client';
import { Alert, Tag } from 'antd';
import type { Language } from '../layout/shell';
import type { EntityLinkPreview, EntityLinkAcceptPreview, EntityLinkStudioInspection, EntityLinkStudioPreview } from '../../../view-models/knowledge/entity-links';
import { KNOWLEDGE_LIBRARY_PATH } from '../../../http/page-paths';
import Link from 'next/link';

export function entityLinkStatusLabel(status: EntityLinkStudioInspection['projection']['status'], lang: Language) {
  const names = { prepared: ['已预约，尚未发送', 'Prepared, not sent'], running: ['已开始，等待归档', 'Started, awaiting archive'],
    execution_unknown: ['调用结果未知', 'Execution outcome unknown'], execution_terminated: ['人工已终止调用', 'Execution terminated by human'], execution_failed: ['结果未接纳', 'Result not admitted'], awaiting_review: ['等待人工核对', 'Awaiting human review'],
    rejected: ['人工已拒绝', 'Rejected by human'], accepted_pending_application: ['已接受，组织待恢复', 'Accepted, organization pending'],
    applied: ['知识库组织已保存', 'Library organization saved'], accepted_conflict: ['已接受，组织冲突', 'Accepted, organization conflict'],
    cancelled_before_start: ['发送前已取消', 'Cancelled before sending'] };
  return names[status][lang === 'zh' ? 0 : 1];
}

function RequestEvidence({ plan, context, lang }: { plan: EntityLinkPreview['plan']; context: unknown; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const proof = context && typeof context === 'object' && 'proof' in context ? context.proof : undefined;
  const endpoint = proof && typeof proof === 'object' && 'endpoint' in proof && typeof proof.endpoint === 'string' ? proof.endpoint : t('不可读', 'Unavailable');
  return <section className="entity-link-request"><h3>{t('精确发送内容与调用身份', 'Exact content and execution identity')}</h3>
    <p>{plan.request.executor} · {plan.request.model}</p><p className="knowledge-workspace">endpoint: {endpoint}</p>
    <p>{t('一次调用，最多 4096 个输出 token；费用未知。模型建议不等于人工身份确认。', 'One invocation, up to 4096 output tokens; cost unknown. A model suggestion is not human identity confirmation.')}</p>
    <details><summary>{t('精确实体与来源身份', 'Exact entity and source identities')}</summary><dl>{([['left', t('左侧原始实体', 'Original left entity')], ['right', t('右侧原始实体', 'Original right entity')]] as const).map(([side, label]) => <div key={side}>
      <dt>{label}</dt><dd><code>{plan[side].analysisId} / {plan[side].entityId}</code><br/>
        <code>{plan[side].entityRevisionId} · {plan[side].snapshotId} · {plan[side].sourceVersion}</code><br/>
        {t('选中提及：', 'Selected mentions: ')}{plan[side].mentionIds.join('，')}<br/>
        {t('当前知识库归属：', 'Current library owner: ')}{plan[side].owner?.objectId ?? t('尚无', 'None')}</dd>
    </div>)}</dl></details>
    <details><summary>{t('查看 endpoint、容量证明与请求摘要', 'Inspect endpoint, capacity proof, and request digest')}</summary><pre>{JSON.stringify(context, null, 2)}</pre><p><code>{plan.request.requestDigest}</code></p></details>
    <details><summary>{t('查看完整 system 与发送原文', 'Inspect complete system and original request')}</summary><h4>system</h4><pre>{plan.request.system}</pre><h4>prompt</h4><pre>{plan.request.prompt}</pre></details>
    <p className="candidate-help">{t('名称只用于召回候选。原实体 UUID 与知识内容保持各自身份，接受只保存知识库组织关系。', 'Names only retrieve candidates. Original entity UUIDs and knowledge retain their identities; acceptance saves only library organization.')}</p>
  </section>;
}

export function EntityLinkPreviewEvidence({ value, lang }: { value: EntityLinkStudioPreview; lang: Language }) {
  return <><p className="knowledge-workspace">{lang === 'zh' ? '确认工作区：' : 'Confirmed workspace: '}{value.workspace}</p>
    <p><code>{value.preview.reviewId}</code></p>
    <div className="entity-link-comparison">{([value.preview.input.left, value.preview.input.right]).map((side, index) => <section key={index}>
      <h3>{side.entity.label}</h3><p>{side.entity.description}</p><p>{side.entity.qualifiers.join(' · ')}</p>
      {side.entity.uncertainties.map((text, i) => <Alert type="warning" title={text} key={i}/>)}
      {side.mentions.map(mention => <blockquote key={mention.mentionId}><q>{mention.selection.quote}</q><p>{mention.rationale}</p><details><summary>{lang === 'zh' ? '精确提及定位' : 'Exact mention location'}</summary><code>{mention.mentionId} · {mention.selection.evidenceRef} [{mention.selection.start}, {mention.selection.end})</code></details></blockquote>)}
      {side.limitations.map((text, i) => <p className="candidate-help" key={i}>{text}</p>)}
    </section>)}</div><RequestEvidence plan={value.preview.plan} context={value.preview.producerContext} lang={lang}/></>;
}

export function EntityLinkAcceptPreviewEvidence({ value, lang }: { value: EntityLinkAcceptPreview; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <section><h3>{t('接受前核对已有成员证据', 'Inspect existing-member evidence before acceptance')}</h3>
    <p>{t('本次零模型调用，尚未保存接受或组织修订。旧组织修订仍保留；无关成员不变。', 'No model call or saved acceptance/library revision. Previous library revisions remain; unrelated members stay unchanged.')}</p>
    <p><code>{value.previewVersion}</code> · generation {value.expectedGeneration}</p>
    <p>{t('组织名称：', 'Organization label: ')}{value.organizationLabel}</p><p>{value.reason}</p>
    <p>{t('已有 owner/head/generation：', 'Existing owner/head/generation: ')}{value.owner ? `${value.owner.objectId} / ${value.owner.headRevisionId} / ${value.owner.generation}` : t('没有已有归属', 'No existing owner')}</p>
    {!value.replacementRequired && <p>{t('没有已有成员证据变化。', 'No existing-member evidence changes.')}</p>}
    {value.changes.map(change => <section key={`${change.before.analysisId}:${change.before.entityId}`}>
      <h4>{t('已有成员：', 'Existing member: ')}<code>{change.before.analysisId} / {change.before.entityId}</code></h4>
      <p>{change.revisionChanged ? t('更新实体修订；两个修订的 mention 身份分开显示，不合并。', 'Entity revision changes; mention identities from the two revisions are displayed separately, never merged.') : t('同一实体修订内改变证据或理由。', 'Evidence or reason changes within the same entity revision.')}</p>
      <p>{t('移除的提及：', 'Removed mentions: ')}{change.removedMentionIds.join(', ') || '—'}</p>
      <p>{t('新增的提及：', 'Added mentions: ')}{change.addedMentionIds.join(', ') || '—'}</p>
      <div className="entity-link-comparison"><div><h4>{t('原绑定（完整）', 'Previous binding (complete)')}</h4><pre>{JSON.stringify(change.before, null, 2)}</pre></div>
        <div><h4>{t('拟写入绑定（完整）', 'Proposed binding (complete)')}</h4><pre>{JSON.stringify(change.after, null, 2)}</pre></div></div>
    </section>)}
    {value.confirmationDigest && <p className="candidate-help">confirmationDigest: <code>{value.confirmationDigest}</code></p>}
  </section>;
}

export function EntityLinkSavedEvidence({ value, lang }: { value: EntityLinkStudioInspection; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const { history, projection } = value;
  const preparation = history.events[0].command;
  const outcome = history.events.find(event => event.command.commandKind === 'execution_recorded')?.command;
  const objectId = projection.decision?.application?.applicationKind === 'intent' ? projection.decision.application.intent.objectId : undefined;
  const applied = history.events.find(event => event.command.commandKind === 'application_applied')?.command;
  return <section className="entity-link-saved"><h3>{t('持久记录与原生证据', 'Durable history and native evidence')}</h3>
    <Tag>{entityLinkStatusLabel(projection.status, lang)}</Tag><p><code>{history.reviewId}</code> · {t('修订', 'Generation')} {history.generation}</p>
    <p className="knowledge-workspace">{t('工作区：', 'Workspace: ')}{value.workspace}</p>
    <p>{t('预约调用：', 'Reserved invocations: ')}{projection.invocationBudget.reserved} · {t('已消耗调用：', 'Consumed invocations: ')}{projection.invocationBudget.consumed} · {t('执行器尝试数：', 'Executor attempts: ')}{projection.executorAttemptCount ?? t('未知', 'Unknown')}</p>
    <p>{t('输入／输出／缓存读取／缓存创建 token：', 'Input / output / cache read / cache creation tokens: ')}{[projection.usage.inputTokens, projection.usage.outputTokens, projection.usage.cacheReadTokens, projection.usage.cacheCreationTokens].map(value => value ?? t('未知', 'Unknown')).join(' / ')} · {t('费用 USD：', 'Cost USD: ')}{projection.usage.costUSD ?? t('未知', 'Unknown')}</p>
    <p className="candidate-help">{t('用量为执行器标准化计数；缓存为 0 不证明提供方明确报告了 0。未知调用不退还预算，也不会自动重新发送。', 'Usage is normalized by the executor; cache zero does not prove a provider explicitly reported zero. Unknown execution does not refund budget or trigger resending.')}</p>
    {projection.termination && <><h4>{t('人工终止记录', 'Human termination record')}</h4>
      <p>{t('处理人：', 'Terminated by: ')}{projection.termination.actor.actorId}</p><p>{projection.termination.reason}</p>
      <p className="candidate-help">{t('终止不证明原进程或请求已停止；迟到结果只保留归档，不进入结构接纳、身份决定或知识库应用。', 'Termination does not prove the original process or request stopped. Late results are archived without admission, identity decisions, or library application.')}</p></>}
    {projection.admission && <><h4>{t('结构接纳', 'Structural admission')}</h4><pre>{JSON.stringify(projection.admission, null, 2)}</pre></>}
    {projection.decision && <><h4>{t('独立人工决定', 'Separate human decision')}</h4><p>{projection.decision.decision} · {projection.decision.actor.actorId}</p><p>{projection.decision.reason}</p></>}
    {projection.conflict && <Alert type="warning" title={`${projection.conflict.classificationVersion} · ${projection.conflict.conflictCode}`} description={projection.conflict.conflictCode === 'kind_mismatch'
      ? t('所指层级不兼容；先核对对象、活动、实例等层级，不能用身份确认覆盖。', 'Referent kinds are incompatible. Inspect object, activity or instance levels; identity consent cannot override this.')
      : projection.conflict.conflictCode === 'identity_unresolved' ? t('先消歧实体身份。legacy/v1 旧原因没有进一步细分，不能据此断言具体层级冲突。', 'Resolve entity identity first. Legacy/v1 reasons remain unclassified and do not establish a specific kind mismatch.') : undefined}/>}
    {projection.status === 'running' || projection.status === 'execution_unknown' ? <Alert type="warning" title={t('先核对同一 review。读取与恢复不会重新发送；原进程仍存活时不能把运行强行判为未知。', 'Inspect this same review first. Reads and recovery never resend; a live owner cannot be forced into unknown.')}/> : null}
    {applied?.commandKind === 'application_applied' && objectId && <Link href={`${KNOWLEDGE_LIBRARY_PATH}?${new URLSearchParams({ workspace: value.workspace, object: objectId })}`}>{t('查看已保存的知识库对象', 'Open the saved library object')}</Link>}
    {preparation.commandKind === 'prepare' && <RequestEvidence plan={preparation.input} context={history.events[0].facts.reservation} lang={lang}/>}
    <details><summary>{t('完整原生结果／失败与用量', 'Complete native result / failure and usage')}</summary><pre>{outcome?.commandKind === 'execution_recorded' ? JSON.stringify(outcome.outcome, null, 2) : t('尚无可用的归档结果。', 'No archived outcome is available.')}</pre></details>
    <details><summary>{t('完整持久事件历史', 'Complete durable event history')}</summary><pre>{JSON.stringify(history, null, 2)}</pre></details>
  </section>;
}
