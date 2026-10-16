'use client';
import { Checkbox, InputNumber, Select } from 'antd';
import type { ExtractionBoundedPolicy, ExtractionGenerationPolicy } from '../../../../observability/application';
import type { Language } from '../layout/shell';

/** A missing policy preserves the existing, single-invocation authorization. */
export function GenerationPolicyFields({ lang, value, onChange, disabled = false, presentation = 'all', scope = 'run' }: {
  lang: Language; value?: ExtractionGenerationPolicy; onChange?(policy: ExtractionGenerationPolicy | undefined): void;
  disabled?: boolean; presentation?: 'all' | 'summary' | 'fields'; scope?: 'run' | 'conversation';
}) {
  const t = (cn: string, en: string) => lang === 'zh' ? cn : en;
  const bounded = value?.policyId === 'knowledge-generation-bounded/v1' ? value : undefined;
  const budgetScope = scope === 'conversation'
    ? t('本次授权跨窗口累计 token 预约总额（同时限制单个运行）', 'Total token reservation across windows for this conversation permission (also caps each run)')
    : t('本运行 token 预约总额', 'Total token reservation for this run');
  function update(fields: Partial<Pick<ExtractionBoundedPolicy, 'maxInvocations' | 'maxReasks' | 'maxTotalTokens' | 'maxOutputTokens'>>) {
    if (!bounded || disabled) return;
    onChange?.({ ...bounded, ...fields });
  }
  function enable(checked: boolean) {
    if (disabled) return;
    onChange?.(checked ? {
      policyId: 'knowledge-generation-bounded/v1', maxInvocations: 3, maxReasks: 2,
      profileId: 'openai-gpt54-snapshot-context/v1', maxTotalTokens: 3_162_288, maxOutputTokens: 4096,
      retry: 'transient-and-empty-validation/v1', fallback: 'none', accounting: 'reserve-upper-bound-no-refund/v1',
      unknownUsage: 'charge-reservation', selection: 'last-attempt-preserve-partial/v1', feedbackVersion: 'knowledge-generation-feedback/v1',
      backoff: { baseMs: 500, capMs: 30_000, retryAfterCapMs: 300_000, jitter: 'full/v1' },
    } : undefined);
  }
  return <>
    {presentation !== 'fields' && <div className="candidate-form" aria-label={t('本次调用与预算', 'Invocation and budget limits')}>
      <p>{bounded
        ? t(`本运行最多 ${bounded.maxInvocations} 次 OMK 调用，含最多 ${bounded.maxReasks} 次校验重问；${budgetScope} ${bounded.maxTotalTokens}，每次输出上限 ${bounded.maxOutputTokens} token。`, `This run permits up to ${bounded.maxInvocations} OMK invocations, including up to ${bounded.maxReasks} validation reasks. ${budgetScope}: ${bounded.maxTotalTokens}, with at most ${bounded.maxOutputTokens} output tokens per invocation.`)
        : t('本运行限 1 次 OMK 调用；校验重问 0 次；未启用 token 预约预算，不自动重试或 fallback。', 'This run permits 1 OMK invocation and 0 validation reasks. No token reservation budget, automatic retry or fallback is enabled.')}</p>
      {bounded && <p className="candidate-help">{t('每次调用前按预算依据的输入与输出上界全额预约；已预约额度不返还，未知用量也不返还。预约预算不表示金额上限。', 'Each invocation reserves the full input and output bounds before dispatch. Reservations are not refunded, including when usage is unknown. This reservation budget is not a spending limit.')}</p>}
    </div>}
    {presentation !== 'summary' && <div className="candidate-form">
      <Checkbox style={{ flexDirection: 'row' }} checked={!!bounded} disabled={disabled} onChange={event => enable(event.target.checked)}>{t('允许按以下上限重试或校验重问', 'Allow retries or validation reasks within these limits')}</Checkbox>
      {bounded && <>
        <label>{t('预算依据', 'Budget profile')}<Select aria-label={t('预算依据', 'Budget profile')} value={bounded.profileId} disabled={disabled} onChange={() => onChange?.({ ...bounded, profileId: 'openai-gpt54-snapshot-context/v1' })}
          options={[{ value: 'openai-gpt54-snapshot-context/v1', label: 'openai-gpt54-snapshot-context/v1' }]}/></label>
        <label>{t('每个运行最多 OMK 调用次数（含重试与重问）', 'Maximum OMK invocations per run (including retries and reasks)')}<InputNumber min={1} max={3} precision={0} value={bounded.maxInvocations} disabled={disabled}
          onChange={number => { if (number !== null) update({ maxInvocations: number, maxReasks: Math.min(bounded.maxReasks, number - 1) }); }}/></label>
        <label>{t('其中最多校验重问次数', 'Maximum validation reasks within that limit')}<InputNumber min={0} max={Math.min(2, bounded.maxInvocations - 1)} precision={0} value={bounded.maxReasks} disabled={disabled}
          onChange={number => { if (number !== null) update({ maxReasks: number }); }}/></label>
        <label>{budgetScope}<InputNumber min={1} max={Number.MAX_SAFE_INTEGER} precision={0} value={bounded.maxTotalTokens} disabled={disabled}
          onChange={number => { if (number !== null) update({ maxTotalTokens: number }); }}/></label>
        <label>{t('每次调用输出 token 上限', 'Output token limit per invocation')}<InputNumber min={1} max={128_000} precision={0} value={bounded.maxOutputTokens} disabled={disabled}
          onChange={number => { if (number !== null) update({ maxOutputTokens: number }); }}/></label>
        <p className="candidate-help">{t('重问计入 OMK 调用总数。当前预算依据仅支持官方 OpenAI API endpoint 与 gpt-5.4-2026-03-05；Codex 默认 single 政策仍可用。预算不足一次完整预约时不会派发。', 'Reasks count toward the OMK invocation limit. This budget profile requires the official OpenAI API endpoint and gpt-5.4-2026-03-05; Codex remains available with the default single policy. No invocation is dispatched without enough budget for its full reservation.')}</p>
      </>}
    </div>}
  </>;
}
