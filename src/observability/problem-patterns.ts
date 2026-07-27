import { createHash } from 'node:crypto';
import { observationMetricAnnotationVerdict } from './review-state.js';
import type { ObservationMetricKey, ObservationReviewState } from '../types/index.js';
import { hasUserHardRuleText, isUserInteractionMetricText } from './text-signals.js';
import type {
  ExperienceProblemBucket,
  ExperienceProblemEvidenceRef,
  ExperienceProblemPattern,
  ExperienceProblemSignal,
  ProblemTimelineEvent,
} from '../types/index.js';

export type {
  ExperienceProblemBucket,
  ExperienceProblemEvidenceRef,
  ExperienceProblemPattern,
  ExperienceProblemSignal,
  ProblemTimelineEvent,
};

interface PatternDraft {
  bucket: ExperienceProblemBucket;
  patternKey: string;
  signalType: ExperienceProblemSignal;
  event: ProblemTimelineEvent;
}

const CORRECTION_RE = /不是这个|不要这样|理解错|看错|你应该|应该是|直接用|直接按|改成|重来|不对|不是|错了/i;
// 负向反馈基础词:不依赖前后语境的明确负向表达。
const NEGATIVE_BASE_RE = /没有用|没用|太慢|别再|怎么又|做错|完全错|垃圾|乱来|瞎搞|白干|浪费时间|没价值|没有价值|没意义|不好用|用不了|没帮助|没有帮助|菜/i;
// 高歧义负向词:前面紧跟描述对象的名词(代码 / 这段 / 这里 等)时, 是在描述对象有问题, 不算用户对 skill 的负向反馈。
// 用 negative lookbehind 先排除"不算"的前缀, 命中即跳过, 一次性 regex。
// 详见 memory: feedback_keyword_context_rule.md。
const NEGATIVE_AMBIGUOUS_RE = /(?<!代码|这段|这部分|这里|那里|方案|方法|地方|文件|内容|写法|设计|字段|逻辑|函数|流程|接口|参数|配置|路径|目录|架构|实现|步骤|做法|思路|样式|布局|算法|文档|输出|结果|结构|文本|展示|渲染|输入|响应|脚本|代码块|代码段|代码片段|规范|标准|约定|风格|网络|信号|环境|机器|电脑)(?:有问题|不需要|看不懂|不符合|不行)/i;
const INTERRUPTION_RE = /\[Request interrupted by user(?: for tool use)?\]|interrupted by user|用户中断/i;
const GOAL_SHIFT_RE = /换个方向|重新来|重来|先不|不用这个|先不用|暂时不用|不看这个|换一个|换下一个|另一个问题|另外一个问题|先看别的|先处理别的|新开一个|新启动一个|另开一个|再开一个|参考.+能力新开|拉下最新|拉取最新|切到最新/i;
const ARTIFACT_MISSING_RE = /没有(?:看到|发现|提供|生成).{0,12}(?:产物|文件|文档|报告|链接|地址|demo)|未(?:生成|提供).{0,12}(?:产物|文件|文档|报告|链接|地址|demo)|产物.*(?:缺失|不存在|打不开|不对题)/i;
const OBSERVER_LIFECYCLE_FAILED_RE = /observer.*(?:lost|failed|killed|stopped)|观察器.*(?:断开|丢失|失败|被.*kill)|runner.*(?:SIGKILL|signal)|后台.*(?:没返回|没通知|断开)/i;
const ORCHESTRATION_BOUNDARY_RE = /父会话.*(?:接手|越界)|调度者.*(?:执行|接手)|parent.*takeover|delegation.*boundary|子任务.*跑偏|child.*goal.*drift/i;
const WORKFLOW_MISMATCH_RE = /流程.*(?:不完整|没跑完|漏了|顺序错误|跑偏)|workflow.*(?:mismatch|incomplete|wrong order)|没有.*(?:执行|完成).*流程/i;

const KEYWORD_GROUPS: Array<{ token: string; re: RegExp }> = [
  { token: 'prd', re: /PRD|prd|需求文档|产品文档/i },
  { token: 'demo', re: /demo|Demo|原型|页面|交互/i },
  { token: 'format', re: /格式|模板|字段|结构|排版|表格|markdown|md|样式|对齐|标题|层级/i },
  { token: 'figma', re: /figma|motiff|设计稿|节点|截图|还原/i },
  { token: 'context', re: /没看|没读|重新读|重读|先看|看一下|参考|上下文|领域|知识|文档|资料|说明|背景/i },
  { token: 'schema', re: /schema|接口|字段|配置|路径|目录|文件|定义|类型|模型/i },
  { token: 'workflow', re: /流程|分支|链路|步骤|顺序|先.+再|不要先|直接走|route|workflow|模式/i },
  { token: 'rule', re: /必须|不要|禁止|严格|一定要|务必|不得|不能|只允许/i },
  { token: 'wrong', re: /不对|不是|错了|错误|理解错|看错|不符合|不一致|漏|缺|少了|多了/i },
  { token: 'tool_limit', re: /exceeds maximum allowed tokens|too many tokens|timeout|timed out|EACCES|ENOENT|permission denied|No such file|not found|失败|error/i },
];

export function buildExperienceProblemPatterns(input: {
  skillName: string;
  sessionId: string;
  timeline: ProblemTimelineEvent[];
  metricScopeId?: string;
  reviewState?: ObservationReviewState;
}): ExperienceProblemPattern[] {
  const drafts: PatternDraft[] = [];
  for (const event of input.timeline) {
    const text = event.snippet ?? event.fullText ?? '';
    if (event.kind === 'user_message') {
      if (!isUserInteractionMetricText(text)) continue;
      if (metricActive(event, 'user_correction', CORRECTION_RE.test(text), input.reviewState, input.metricScopeId)) {
        drafts.push(patternDraft(input.skillName, 'user_correction', event));
      }
      if (metricActive(event, 'negative_feedback', NEGATIVE_BASE_RE.test(text) || NEGATIVE_AMBIGUOUS_RE.test(text), input.reviewState)) {
        drafts.push(patternDraft(input.skillName, 'negative_feedback', event));
      }
      if (metricActive(event, 'user_interruption', INTERRUPTION_RE.test(text), input.reviewState, input.metricScopeId)) {
        drafts.push(patternDraft(input.skillName, 'user_interruption', event));
      }
      if (metricActive(event, 'hard_rule', hasUserHardRuleText(text), input.reviewState, input.metricScopeId)) {
        drafts.push(patternDraft(input.skillName, 'hard_rule', event));
      }
      if (metricActive(event, 'user_goal_shift', GOAL_SHIFT_RE.test(text), input.reviewState, input.metricScopeId)) {
        drafts.push(patternDraft(input.skillName, 'user_goal_shift', event));
      }
      if (ARTIFACT_MISSING_RE.test(text)) {
        drafts.push(patternDraft(input.skillName, 'artifact_missing', event));
      }
      if (WORKFLOW_MISMATCH_RE.test(text)) {
        drafts.push(patternDraft(input.skillName, 'workflow_mismatch', event));
      }
      if (ORCHESTRATION_BOUNDARY_RE.test(text)) {
        drafts.push(patternDraft(input.skillName, 'orchestration_boundary_violation', event));
      }
    } else if (event.kind === 'tool_result' && event.isError === true) {
      drafts.push(patternDraft(input.skillName, OBSERVER_LIFECYCLE_FAILED_RE.test(text) ? 'observer_lifecycle_failed' : 'tool_failure', event));
    } else if (event.kind === 'assistant_message' || event.kind === 'runtime_context') {
      if (OBSERVER_LIFECYCLE_FAILED_RE.test(text)) {
        drafts.push(patternDraft(input.skillName, 'observer_lifecycle_failed', event));
      }
      if (ORCHESTRATION_BOUNDARY_RE.test(text)) {
        drafts.push(patternDraft(input.skillName, 'orchestration_boundary_violation', event));
      }
      if (ARTIFACT_MISSING_RE.test(text)) {
        drafts.push(patternDraft(input.skillName, 'artifact_missing', event));
      }
    }
  }
  return mergeExperienceProblemPatterns(drafts.map((draft) => patternFromDraft(input.skillName, input.sessionId, draft)));
}

export function mergeExperienceProblemPatterns(patterns: ExperienceProblemPattern[]): ExperienceProblemPattern[] {
  const byKey = new Map<string, ExperienceProblemPattern>();
  for (const pattern of patterns) {
    const key = `${pattern.bucket}\u0000${pattern.patternKey}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...pattern,
        recentSessionIds: unique(pattern.recentSessionIds).slice(0, 5),
        signalTypes: unique(pattern.signalTypes),
        evidenceRefs: uniqueEvidenceRefs(pattern.evidenceRefs).slice(0, 5),
        sessionCount: unique(pattern.recentSessionIds).length,
        count: uniqueEvidenceRefs(pattern.evidenceRefs).length || pattern.count,
      });
      continue;
    }
    const evidenceRefs = uniqueEvidenceRefs([...existing.evidenceRefs, ...pattern.evidenceRefs]);
    const sessions = unique([...existing.recentSessionIds, ...pattern.recentSessionIds]);
    existing.count = evidenceRefs.length;
    existing.sessionCount = sessions.length;
    existing.recentSessionIds = sessions.slice(0, 5);
    existing.signalTypes = unique([...existing.signalTypes, ...pattern.signalTypes]);
    existing.evidenceRefs = evidenceRefs.slice(0, 5);
    existing.lastSeen = maxTimestamp(existing.lastSeen, pattern.lastSeen);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
    return (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '');
  });
}

function patternDraft(skillName: string, signalType: ExperienceProblemSignal, event: ProblemTimelineEvent): PatternDraft {
  const text = event.snippet ?? event.fullText ?? '';
  const bucket = bucketFor(signalType, text);
  return {
    bucket,
    patternKey: patternKeyFor(skillName, bucket, signalType, text, event),
    signalType,
    event,
  };
}

function patternFromDraft(skillName: string, sessionId: string, draft: PatternDraft): ExperienceProblemPattern {
  const evidenceRef = evidenceRefFromEvent(draft.event);
  return {
    id: hashParts('problem-pattern', skillName, draft.bucket, draft.patternKey),
    bucket: draft.bucket,
    patternKey: draft.patternKey,
    count: 1,
    sessionCount: 1,
    recentSessionIds: [sessionId],
    signalTypes: [draft.signalType],
    evidenceRefs: [evidenceRef],
    lastSeen: draft.event.timestamp,
  };
}

function bucketFor(signalType: ExperienceProblemSignal, text: string): ExperienceProblemBucket {
  if (signalType === 'artifact_missing') return 'missing_context';
  if (signalType === 'observer_lifecycle_failed') return 'tool_runtime';
  if (signalType === 'orchestration_boundary_violation') return 'rule_violation';
  if (signalType === 'workflow_mismatch') return 'workflow_mismatch';
  if (signalType === 'tool_failure') return 'tool_runtime';
  if (signalType === 'user_goal_shift') return 'goal_shift';
  if (signalType === 'user_interruption') return 'workflow_mismatch';
  if (signalType === 'hard_rule') return 'rule_violation';
  if (/格式|模板|字段|结构|排版|表格|markdown|md|样式|对齐|标题|层级|PRD|prd/i.test(text)) return 'output_format';
  if (/没看|没读|重新读|重读|先看|看一下|参考|上下文|领域|知识|文档|资料|schema|接口|配置|路径|目录|文件|定义/i.test(text)) return 'missing_context';
  if (/流程|分支|链路|步骤|顺序|先.+再|不要先|直接走|route|workflow|模式/i.test(text)) return 'workflow_mismatch';
  if (/必须|不要|禁止|严格|一定要|务必|不得|不能|只允许/i.test(text)) return 'rule_violation';
  if (/不对|不是|错了|错误|理解错|看错|不符合|不一致|漏|缺|少了|多了|做错/i.test(text)) return 'content_accuracy';
  return 'unclear';
}

function patternKeyFor(
  skillName: string,
  bucket: ExperienceProblemBucket,
  signalType: ExperienceProblemSignal,
  text: string,
  event: ProblemTimelineEvent,
): string {
  if (bucket === 'tool_runtime') {
    return `${bucket}:${normalizeToken(event.toolName || errorToken(text) || 'tool_failure')}`;
  }
  const tokens = KEYWORD_GROUPS
    .filter((group) => group.re.test(text))
    .map((group) => group.token);
  if (tokens.length > 0) return `${bucket}:${unique(tokens).slice(0, 3).join('+')}`;
  const normalized = normalizeText(text).slice(0, 28);
  return `${bucket}:${signalType}:${normalized || normalizeToken(skillName) || 'unknown'}`;
}

function errorToken(text: string): string {
  if (/exceeds maximum allowed tokens|too many tokens/i.test(text)) return 'tool_limit';
  if (/ENOENT|No such file|not found/i.test(text)) return 'not_found';
  if (/EACCES|permission denied/i.test(text)) return 'permission';
  if (/timeout|timed out/i.test(text)) return 'timeout';
  return 'tool_failure';
}

function metricActive(
  event: ProblemTimelineEvent,
  metricKey: ObservationMetricKey,
  ruleDetected: boolean,
  reviewState?: ObservationReviewState,
  metricScopeId?: string,
): boolean {
  const verdict = observationMetricAnnotationVerdict(reviewState, { ...event, metricScopeId }, metricKey);
  if (verdict === 'confirmed') return true;
  if (verdict === 'rejected') return false;
  return ruleDetected;
}

function evidenceRefFromEvent(event: ProblemTimelineEvent): ExperienceProblemEvidenceRef {
  return {
    id: event.id,
    kind: event.kind,
    traceId: event.traceId,
    sourceTrace: event.sourceTrace,
    sessionId: event.sessionId,
    messageIndex: event.messageIndex,
    logicalMessageIndex: event.logicalMessageIndex ?? event.messageIndex,
    sourceLineIndex: event.sourceLineIndex ?? event.messageIndex,
    messageUuid: event.messageUuid,
    callInstanceId: event.callInstanceId,
    toolUseId: event.toolUseId,
    timestamp: event.timestamp,
    role: event.role,
    label: event.label,
    snippet: event.snippet,
  };
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[a-f0-9]{8,}/g, ' id ')
    .replace(/[0-9]+/g, ' n ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '_');
}

function normalizeToken(value: string): string {
  return normalizeText(value).slice(0, 32) || 'unknown';
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function uniqueEvidenceRefs(refs: ExperienceProblemEvidenceRef[]): ExperienceProblemEvidenceRef[] {
  const byId = new Map<string, ExperienceProblemEvidenceRef>();
  for (const ref of refs) byId.set(ref.id, ref);
  return Array.from(byId.values());
}

function maxTimestamp(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function hashParts(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}
