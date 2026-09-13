import type {
  ObservationEvidence,
  ObservationInboxItem,
} from '../contracts/inbox.js';
import type { TraceSourceKind } from '../contracts/trace.js';
import { severityReasonFor } from './severity-reason.js';

/**
 * 观测收件箱信号子视图的展示语义（宿主无关纯函数）。
 * 文案与映射只此一份，React 页面（studio/web/components/inbox）直接消费，
 * 避免出现第二套业务语义。样式（色值、布局）仍归呈现层；这里只输出语义字段与 tone。
 */

export type SignalSeverityTone = 'error' | 'warning' | 'info' | 'neutral';

export interface SignalSeverityMeta {
  readonly label: string;
  readonly decision: string;
  readonly tone: SignalSeverityTone;
}

type SignalItem = Pick<ObservationInboxItem, 'signalType' | 'signalSubtype' | 'severity' | 'confidence' | 'evidence' | 'severityReasonCode' | 'occurrences'>;

const SEVERITY_META_ZH: Record<ObservationInboxItem['severity'], { label: string; decision: string }> = {
  high: { label: '高风险/需关注', decision: '优先看，可能要补 SKILL.md 或改 skill 说明' },
  medium: { label: '低风险/抽样确认', decision: '通常不需要改 skill；抽样确认是否反复浪费时间' },
  low: { label: '不确定/低优先级', decision: '模型只是说不确定，不一定需要改 skill' },
  noise: { label: '无异常/无需改 skill', decision: '更像路径、权限、文件太大或工具限制；先不当成 skill 内容缺失' },
};

const SEVERITY_META_EN: Record<ObservationInboxItem['severity'], { label: string; decision: string }> = {
  high: { label: 'High risk', decision: 'Review first; the SKILL.md or skill description may need changes' },
  medium: { label: 'Low risk / sample-check', decision: 'Usually no skill change; sample-check whether time is repeatedly wasted' },
  low: { label: 'Uncertain / low priority', decision: 'The model only expressed uncertainty; no skill change is implied' },
  noise: { label: 'Noise / no skill change', decision: 'More likely path, permission, file-size or tool limits; not a skill content gap' },
};

const SEVERITY_TONE: Record<ObservationInboxItem['severity'], SignalSeverityTone> = {
  high: 'error',
  medium: 'warning',
  low: 'info',
  noise: 'neutral',
};

export function signalSeverityMeta(severity: ObservationInboxItem['severity'], lang: 'zh' | 'en' = 'zh'): SignalSeverityMeta {
  const meta = (lang === 'en' ? SEVERITY_META_EN : SEVERITY_META_ZH)[severity];
  return { ...meta, tone: SEVERITY_TONE[severity] };
}

function evidenceTool(evidence: ObservationEvidence, lang: 'zh' | 'en'): string {
  return evidence.tool || (lang === 'en' ? 'Tool' : '工具');
}

function evidenceTarget(evidence: ObservationEvidence): string {
  return evidence.query || evidence.path || evidence.assistantSnippet || '';
}

/** 语义证据行（非完整句式），按 signalSubtype 描述证据形态。 */
export function signalSemanticEvidence(item: Pick<SignalItem, 'signalSubtype' | 'evidence'>, lang: 'zh' | 'en' = 'zh'): string {
  const tool = item.evidence.tool || 'Tool';
  const target = evidenceTarget(item.evidence);
  const output = item.evidence.outputSnippet || target;
  if (lang === 'en') {
    switch (item.signalSubtype) {
      case 'tool_limit': return `${tool} hit a tool limit: ${output}`;
      case 'transient_file_missing': return `${tool} read a temporary file that does not exist: ${item.evidence.path || target}`;
      case 'skill_asset_read_failed': return `${tool} failed to read the skill's own asset: ${item.evidence.path || target}`;
      case 'not_found': return `${tool} accessed a path that does not exist: ${item.evidence.path || target}`;
      case 'permission_denied': return `${tool} was denied by permissions: ${item.evidence.path || target}`;
      case 'bash_probe': return `During the skill run, the agent invoked a Bash command: ${item.evidence.query || target}`;
      case 'hard_miss': return `${tool} missed and no later success on the same topic: ${target}`;
      case 'exploratory_miss': return `${tool} missed first, but later searches succeeded: ${target}`;
      default: return target || item.evidence.outputSnippet || '';
    }
  }
  switch (item.signalSubtype) {
    case 'tool_limit': return `${tool} 触发工具限制：${output}`;
    case 'transient_file_missing': return `${tool} 访问了临时文件但文件不存在：${item.evidence.path || target}`;
    case 'skill_asset_read_failed': return `${tool} 读取该 skill 自身资源失败：${item.evidence.path || target}`;
    case 'not_found': return `${tool} 访问了不存在的路径：${item.evidence.path || target}`;
    case 'permission_denied': return `${tool} 被权限拒绝：${item.evidence.path || target}`;
    case 'bash_probe': return `skill 运行过程中，agent 调用了一条 Bash 命令：${item.evidence.query || target}`;
    case 'hard_miss': return `${tool} 未命中且后续未找到同主题成功证据：${target}`;
    case 'exploratory_miss': return `${tool} 前序未命中，但后续有成功搜索证据：${target}`;
    default: return target || item.evidence.outputSnippet || '';
  }
}

/** 证据结论（完整句式），供表格主文案与详情列表使用。 */
export function signalEvidenceConclusion(item: Pick<SignalItem, 'signalType' | 'signalSubtype' | 'evidence'>, lang: 'zh' | 'en' = 'zh'): string {
  const tool = evidenceTool(item.evidence, lang);
  if (lang === 'en') {
    switch (item.signalSubtype) {
      case 'bash_probe': return 'During the skill run, the agent invoked a Bash command.';
      case 'tool_limit': return `${tool} hit a file-length, token or timeout limit.`;
      case 'transient_file_missing': return `${tool} read a temporary file that does not exist.`;
      case 'skill_asset_read_failed': return `${tool} failed to read the skill's own asset.`;
      case 'not_found': return `${tool} accessed a path that does not exist.`;
      case 'permission_denied': return `${tool} was denied by permissions.`;
      case 'hard_miss': return `${tool} returned nothing useful, and no later success on the same topic was observed.`;
      case 'exploratory_miss': return `${tool} returned nothing at first, but later searches found the content.`;
      default: break;
    }
    if (item.signalType === 'hedging') return 'The model text contains hedging expressions.';
    if (item.signalType === 'explicit_marker') return 'The model text contains an explicit marker.';
    return signalSemanticEvidence(item, lang);
  }
  switch (item.signalSubtype) {
    case 'bash_probe': return 'skill 运行过程中，agent 调用了一条 Bash 命令。';
    case 'tool_limit': return `${tool} 触发了文件太长、token 或超时限制。`;
    case 'transient_file_missing': return `${tool} 访问了临时文件，但文件不存在。`;
    case 'skill_asset_read_failed': return `${tool} 读取该 skill 自身资源失败。`;
    case 'not_found': return `${tool} 访问了不存在的路径。`;
    case 'permission_denied': return `${tool} 被权限拒绝。`;
    case 'hard_miss': return `${tool} 没有拿到有效结果，后续也没有看到同主题成功证据。`;
    case 'exploratory_miss': return `${tool} 前面没有拿到结果，但后续找到了相关内容。`;
    default: break;
  }
  if (item.signalType === 'hedging') return '模型文本里出现了不确定表达。';
  if (item.signalType === 'explicit_marker') return '模型文本里出现了显式标记。';
  return signalSemanticEvidence(item, lang);
}

/** 信号帮助气泡的完整描述（label: type/subtype, confidence=x.xx. reason）。 */
export function signalRuleDescription(item: SignalItem, lang: 'zh' | 'en' = 'zh'): string {
  const meta = signalSeverityMeta(item.severity, lang);
  const prefix = `${meta.label}: ${item.signalType}/${item.signalSubtype}, confidence=${item.confidence.toFixed(2)}.`;
  return `${prefix} ${severityReasonFor(item, lang)}`;
}

export interface SignalSourceMeta {
  readonly label: string;
  readonly tone: 'teal' | 'purple' | 'geekblue' | 'green' | 'blue' | 'neutral';
}

export function signalSourceMeta(sourceKind: TraceSourceKind): SignalSourceMeta {
  switch (sourceKind) {
    case 'dsh': return { label: 'DeepSeek Harness', tone: 'teal' };
    case 'openclaw': return { label: 'OpenClaw', tone: 'purple' };
    case 'codex': return { label: 'Codex', tone: 'geekblue' };
    case 'markdown_log': return { label: 'Markdown log', tone: 'green' };
    case 'claude': return { label: 'Claude', tone: 'blue' };
    default: return { label: 'Unknown', tone: 'neutral' };
  }
}
