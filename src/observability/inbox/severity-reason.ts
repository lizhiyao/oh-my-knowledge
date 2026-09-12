import type { ObservationInboxItem, ObservationSeverityReasonCode } from '../contracts/inbox.js';

/**
 * 严重度理由的纯函数与字典（无文件系统依赖）。
 * 宿主无关：signal-semantics 与页面按需引入，文案只此一份。
 */

const SEVERITY_REASON_ZH: Record<ObservationSeverityReasonCode, string> = {
  repeated_failure_suspected: '同类搜索连续失败 3 次以上，是强缺口信号，高于单次 hard_miss。',
  explicit_gap_marker: 'agent 主动输出了知识缺口/未知标记，需要优先人工确认。',
  knowledge_gap_suspected: '{tool}失败后，session 内未找到同主题成功证据，疑似知识缺口。',
  exploratory_probe: 'skill 运行过程中出现了试路径、试目录或前序失败后后续成功的行为；先抽样确认，不直接判为要改 skill。',
  skill_asset_unavailable: '读取该 skill 自身资源失败，可能是路径错位、资源未提交或 ignore 配置问题。',
  soft_hedging_signal: '模型文本里出现了不确定表达，属于低置信文本信号，需要结合上下文人工判断。',
  user_reported_knowledge_issue: '用户明确提交了真实使用中的 knowledge 问题；当前只保留用户授权提交的部分证据，需人工复核后再进入样本集。',
  tool_or_runtime_noise: '更像路径、权限、文件太大、临时文件或工具运行问题；通常不作为 skill 内容缺失。',
};

const SEVERITY_REASON_EN: Record<ObservationSeverityReasonCode, string> = {
  repeated_failure_suspected: 'Similar searches failed at least three times; this is stronger than a single hard miss.',
  explicit_gap_marker: 'The agent explicitly marked an unknown or knowledge gap; review this first.',
  knowledge_gap_suspected: '{tool}failed and no later same-topic success was found in the session.',
  exploratory_probe: 'The event looks like path probing, directory probing, or an earlier miss followed by later success; sample it before changing the skill.',
  skill_asset_unavailable: 'The agent failed to read an asset inside the skill itself; check path alignment, committed resources, or ignore rules.',
  soft_hedging_signal: 'The agent used uncertain wording; treat this as a low-confidence text signal.',
  user_reported_knowledge_issue: 'The user explicitly submitted a knowledge issue from real usage; only the authorized partial evidence is retained until human review.',
  tool_or_runtime_noise: 'This looks like a path, permission, token limit, transient file, or runtime tool issue rather than missing skill content.',
};

export function severityReasonFor(item: Pick<ObservationInboxItem, 'signalType' | 'signalSubtype' | 'severity' | 'confidence' | 'evidence' | 'severityReasonCode'>, lang: 'zh' | 'en' = 'zh'): string {
  const code = item.severityReasonCode ?? severityReasonCodeFor(item);
  const tool = item.evidence.tool ? `${item.evidence.tool} ` : '';
  const dictionary = lang === 'en' ? SEVERITY_REASON_EN : SEVERITY_REASON_ZH;
  return dictionary[code].replace('{tool}', tool);
}

export function severityReasonCodeFor(item: Pick<ObservationInboxItem, 'signalType' | 'signalSubtype' | 'severity' | 'confidence'>): ObservationSeverityReasonCode {
  if (item.signalType === 'user_feedback') return 'user_reported_knowledge_issue';
  if (item.signalSubtype === 'repeated_failure') return 'repeated_failure_suspected';
  if (item.signalType === 'explicit_marker') return 'explicit_gap_marker';
  if (item.signalSubtype === 'hard_miss') return 'knowledge_gap_suspected';
  if (item.signalSubtype === 'skill_asset_read_failed') return 'skill_asset_unavailable';
  if (item.signalSubtype === 'exploratory_miss' || item.signalSubtype === 'bash_probe') return 'exploratory_probe';
  if (item.signalType === 'hedging') return 'soft_hedging_signal';
  return 'tool_or_runtime_noise';
}
