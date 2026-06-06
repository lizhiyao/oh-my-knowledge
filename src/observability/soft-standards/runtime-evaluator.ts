import type {
  SkillRuntimeEvidencePack,
  SkillRuntimeEvidencePackNode,
  SkillRuntimeEvidencePackRef,
} from '../skill-chain.js';
import type {
  RuntimeMatchedSignal,
  RuntimeNodeResult,
  RuntimeNodeVerdict,
  RuntimeSignal,
  RuntimeSignalOp,
  RuntimeSignalRef,
  RuntimeSignalType,
  RuntimeStandardNode,
  RuntimeTriggerWindowScope,
} from './types.js';

type RuntimeSignalGroupName = RuntimeSignalRef['signalGroup'];

interface RuntimeSignalMatch {
  signal: RuntimeSignal;
  group: RuntimeSignalGroupName;
  refs: SkillRuntimeEvidencePackRef[];
}

interface RuntimeEvaluationContext {
  nodeScopedRefs: SkillRuntimeEvidencePackRef[];
}

export function evaluateRuntimeStandardNodes(nodes: RuntimeStandardNode[], evidencePack: SkillRuntimeEvidencePack): RuntimeNodeResult[] {
  const rawResults = nodes.map((node) => evaluateRuntimeStandardNode(node, evidencePack, {
    nodeScopedRefs: resolveNodeScopedRefs(node, evidencePack),
  }));
  const resultByNodeId = new Map(rawResults.map((result) => [result.nodeId, result]));
  return rawResults.map((result) => {
    const node = nodes.find((item) => item.nodeId === result.nodeId);
    if (!node || node.nodeKind !== 'stage' || !node.childNodeIds || node.childNodeIds.length === 0) return result;
    const childResults = node.childNodeIds
      .map((id) => resultByNodeId.get(id))
      .filter((item): item is RuntimeNodeResult => Boolean(item));
    if (childResults.length === 0) {
      return { ...result, status: 'unknown', reason: '阶段包含子节点，但本次没有找到可复核的子节点结果。' };
    }
    const status = aggregateRuntimeNodeStatuses(childResults.map((item) => item.status));
    return {
      ...result,
      status,
      matchedSignals: dedupeMatchedSignals([...result.matchedSignals, ...childResults.flatMap((item) => item.matchedSignals)]),
      evidenceRefs: dedupeEvidenceRefs([...result.evidenceRefs, ...childResults.flatMap((item) => item.evidenceRefs)]),
      reason: `阶段结果由 ${childResults.length} 个子节点汇总：${runtimeNodeStatusReason(status)}`,
    };
  });
}

function evaluateRuntimeStandardNode(node: RuntimeStandardNode, evidencePack: SkillRuntimeEvidencePack, context: RuntimeEvaluationContext): RuntimeNodeResult {
  const matches = buildSignalMatches(node, evidencePack);
  const matchedSignals = Array.from(matches.values()).filter((match) => match.refs.length > 0);
  const triggerStatuses = evaluateRuntimeTriggers(node, matches, context);
  const status = node.triggers.length > 0
    ? triggerStatuses.length > 0 ? aggregateRuntimeNodeStatuses(triggerStatuses) : 'unknown'
    : inferRuntimeNodeStatusWithoutTriggers(node, matches);
  const evidenceRefs = dedupeEvidenceRefs(matchedSignals.flatMap((match) => match.refs));
  return {
    nodeId: node.nodeId,
    nodeKind: node.nodeKind,
    title: node.title,
    status,
    matchedSignals: matchedSignals.map((match) => ({
      signalId: match.signal.id,
      signalType: match.signal.type,
      signalGroup: match.group,
      evidenceRefs: match.refs.slice(0, 5),
    })),
    evidenceRefs: evidenceRefs.slice(0, 10),
    reason: buildRuntimeNodeReason(node, status, matchedSignals),
  };
}

export function resolveNodeScopedRefs(node: RuntimeStandardNode, evidencePack: SkillRuntimeEvidencePack): SkillRuntimeEvidencePackRef[] {
  const byId = new Map(evidencePack.nodeEvidence.map((entry) => [entry.nodeId, entry]));
  const explicit = node.nodeEvidenceRef ? byId.get(node.nodeEvidenceRef) : undefined;
  if (explicit) return explicit.candidateEvidenceRefs;
  const exact = byId.get(node.nodeId);
  if (exact) return exact.candidateEvidenceRefs;

  const scored = evidencePack.nodeEvidence
    .map((entry) => ({ entry, score: scoreNodeEvidenceCandidate(node, entry) }))
    .filter((item) => item.score >= 4)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best) return [];
  if (second && best.score === second.score) return [];
  return best.entry.candidateEvidenceRefs;
}

function scoreNodeEvidenceCandidate(node: RuntimeStandardNode, candidate: SkillRuntimeEvidencePackNode): number {
  let score = 0;
  const candidateText = normalizeFuzzyText(`${candidate.title}\n${candidate.expectation}`);
  const nodeText = normalizeFuzzyText([
    node.title,
    node.description,
    ...node.sourceHints.map((hint) => hint.snippet),
  ].filter(Boolean).join('\n'));
  if (nodeText && candidateText) {
    if (candidateText.includes(nodeText) || nodeText.includes(candidateText)) score += 3;
    else if (nodeText.length >= 10 && candidateText.length >= 10 && hasMeaningfulTokenOverlap(nodeText, candidateText)) score += 2;
  }

  const signals = [
    ...node.expectedSignals,
    ...node.failureSignals,
    ...node.forbiddenSignals,
    ...node.conditionSignals,
  ];
  const matchedSignalIds = new Set<string>();
  for (const signal of signals) {
    if (candidate.candidateEvidenceRefs.some((ref) => refMatchesRuntimeSignal(ref, signal))) {
      matchedSignalIds.add(signal.id);
      score += signalMatchWeight(signal.type);
    }
  }
  if (matchedSignalIds.size >= 2) score += 2;
  return score;
}

function hasMeaningfulTokenOverlap(left: string, right: string): boolean {
  const tokens = new Set(left.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter((token) => token.length >= 2));
  let overlap = 0;
  for (const token of right.split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
    if (token.length >= 2 && tokens.has(token)) overlap += 1;
    if (overlap >= 2) return true;
  }
  return false;
}

function signalMatchWeight(type: RuntimeSignalType): number {
  if (type === 'tool_name' || type === 'event_kind' || type === 'artifact_kind' || type === 'artifact_path') return 4;
  return 2;
}

function buildSignalMatches(node: RuntimeStandardNode, evidencePack: SkillRuntimeEvidencePack): Map<string, RuntimeSignalMatch> {
  const refs = runtimeEvidenceRefs(evidencePack);
  const groups: Array<[RuntimeSignalGroupName, RuntimeSignal[]]> = [
    ['expectedSignals', node.expectedSignals],
    ['failureSignals', node.failureSignals],
    ['forbiddenSignals', node.forbiddenSignals],
    ['conditionSignals', node.conditionSignals],
  ];
  const out = new Map<string, RuntimeSignalMatch>();
  for (const [group, signals] of groups) {
    for (const signal of signals) {
      const key = signalKey(group, signal.id);
      out.set(key, {
        signal,
        group,
        refs: refs.filter((ref) => refMatchesRuntimeSignal(ref, signal)).slice(0, 20),
      });
    }
  }
  return out;
}

function runtimeEvidenceRefs(evidencePack: SkillRuntimeEvidencePack): SkillRuntimeEvidencePackRef[] {
  const refs = [
    ...evidencePack.runtimeEvidence.toolCalls,
    ...evidencePack.runtimeEvidence.assistantMessages,
    ...evidencePack.runtimeEvidence.userFeedback,
    ...evidencePack.runtimeEvidence.artifacts,
    ...evidencePack.nodeEvidence.flatMap((node) => node.candidateEvidenceRefs),
  ].filter((ref) => ref.sourceType !== 'runtime_context' && ref.sourceType !== 'skill_context');
  return dedupeEvidenceRefs(refs);
}

function refMatchesRuntimeSignal(ref: SkillRuntimeEvidencePackRef, signal: RuntimeSignal): boolean {
  const text = runtimeSignalTextForRef(ref, signal.type);
  if (!text) return false;
  return runtimeSignalValueMatches(text, signal.value, signal.op ?? 'contains', signal.type);
}

function runtimeSignalTextForRef(ref: SkillRuntimeEvidencePackRef, type: RuntimeSignalType): string {
  if (type === 'tool_name') return ref.sourceType === 'tool_call' || ref.sourceType === 'tool_result' ? (ref.toolName || ref.label || ref.snippet || '') : '';
  if (type === 'tool_input') return ref.sourceType === 'tool_call' ? `${ref.label ?? ''}\n${ref.snippet ?? ''}` : '';
  if (type === 'tool_output') return ref.sourceType === 'tool_result' ? `${ref.label ?? ''}\n${ref.snippet ?? ''}` : '';
  if (type === 'assistant_text') return ref.sourceType === 'assistant_message' ? `${ref.label ?? ''}\n${ref.snippet ?? ''}` : '';
  if (type === 'user_text') return ref.sourceType === 'user_feedback' ? `${ref.label ?? ''}\n${ref.snippet ?? ''}` : '';
  if (type === 'artifact_kind') return ref.sourceType === 'artifact' ? inferArtifactKind(ref) : '';
  if (type === 'artifact_path') return ref.sourceType === 'artifact' ? `${ref.label ?? ''}\n${ref.snippet ?? ''}` : '';
  if (type === 'event_kind') return ref.kind ?? '';
  return '';
}

function runtimeSignalValueMatches(text: string, value: string | string[], op: RuntimeSignalOp, type: RuntimeSignalType): boolean {
  const values = Array.isArray(value) ? value : [value];
  if (op === 'any_of') return values.some((entry) => runtimeSignalValueMatches(text, entry, defaultOpForSignalType(type), type));
  return values.some((entry) => {
    const left = comparableSignalText(text, type, op);
    const right = comparableSignalText(entry, type, op);
    if (!right) return false;
    if (op === 'equals') return left.trim() === right.trim();
    if (op === 'contains' || op === 'fuzzy_contains') return left.includes(right);
    if (op === 'suffix') return left.trim().endsWith(right.trim());
    if (op === 'glob') return globMatchesSignalText(text, right);
    return false;
  });
}

function comparableSignalText(value: string, type: RuntimeSignalType, op: RuntimeSignalOp): string {
  if (op === 'fuzzy_contains') return normalizeFuzzyText(value);
  if (type === 'tool_name') return normalizeToolNameValue(value);
  return value.toLowerCase();
}

export function normalizeToolNameValue(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[-_\s]+/g, '');
  const aliases: Record<string, string> = {
    yuquecli: 'yuque',
    yuqueantcli: 'yuque',
    skylarkdocdetail: 'skylark',
    skylarkresolveurl: 'skylark',
  };
  return aliases[normalized] ?? normalized;
}

function defaultOpForSignalType(type: RuntimeSignalType): RuntimeSignalOp {
  if (type === 'tool_name' || type === 'artifact_kind' || type === 'event_kind') return 'equals';
  return 'contains';
}

export function normalizeFuzzyText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s　]+/g, ' ')
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~，。！？、；：“”‘’（）【】《》]/g, '')
    .trim();
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'is');
}

function globMatchesSignalText(text: string, pattern: string): boolean {
  const matcher = globToRegExp(pattern);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => matcher.test(line) || matcher.test(line.split(/[\\/]/).pop() ?? line));
}

function inferArtifactKind(ref: SkillRuntimeEvidencePackRef): string {
  const text = `${ref.label ?? ''}\n${ref.snippet ?? ''}`.toLowerCase();
  if (/\.png\b|\.jpg\b|\.jpeg\b|\.gif\b|\.webp\b|截图|图片|image/.test(text)) return 'image';
  if (/\.html\b|preview_url|预览|demo|页面/.test(text)) return 'demo';
  if (/\.md\b|文档|报告|方案|prd|document/.test(text)) return 'document';
  if (/https?:\/\//.test(text)) return 'url';
  if (/\.ts\b|\.tsx\b|\.js\b|\.jsx\b|\.py\b|代码|code/.test(text)) return 'code';
  return 'file';
}

function evaluateRuntimeTriggers(node: RuntimeStandardNode, matches: Map<string, RuntimeSignalMatch>, context: RuntimeEvaluationContext): RuntimeNodeVerdict[] {
  const statuses: RuntimeNodeVerdict[] = [];
  for (const trigger of node.triggers) {
    const whenRefs = trigger.when
      ? refsInScope(refsForSignalRef(matches, trigger.when), [], trigger.windowScope === 'same_node' ? 'same_node' : 'anywhere_in_session', context)
      : [];
    if (trigger.when && whenRefs.length === 0) continue;
    if (trigger.forbidden) {
      const forbiddenRefs = refsInScope(refsForSignalRef(matches, trigger.forbidden), whenRefs, trigger.windowScope, context);
      if (forbiddenRefs.length > 0) statuses.push(trigger.verdict);
      continue;
    }
    if (trigger.required) {
      const requiredRefs = refsInScope(refsForSignalRef(matches, trigger.required), whenRefs, trigger.windowScope, context);
      if (requiredRefs.length > 0) statuses.push(trigger.verdict);
      else statuses.push('missed');
      continue;
    }
    if (trigger.absence) {
      const absentRefs = refsInScope(refsForSignalRef(matches, trigger.absence), whenRefs, trigger.windowScope, context);
      statuses.push(absentRefs.length === 0 ? trigger.verdict : 'violated');
      continue;
    }
    if (trigger.when) statuses.push(trigger.verdict);
  }
  return statuses;
}

function refsForSignalRef(matches: Map<string, RuntimeSignalMatch>, ref: RuntimeSignalRef): SkillRuntimeEvidencePackRef[] {
  return matches.get(signalKey(ref.signalGroup, ref.signalId))?.refs ?? [];
}

export function refsInScope(
  refs: SkillRuntimeEvidencePackRef[],
  anchorRefs: SkillRuntimeEvidencePackRef[],
  scope: RuntimeTriggerWindowScope,
  context: RuntimeEvaluationContext = { nodeScopedRefs: [] },
): SkillRuntimeEvidencePackRef[] {
  if (scope === 'same_node') {
    if (context.nodeScopedRefs.length === 0) return [];
    const scopedIds = new Set(context.nodeScopedRefs.map((ref) => ref.id));
    return refs.filter((ref) => scopedIds.has(ref.id));
  }
  if (scope === 'anywhere_in_session') return refs;
  if (scope === 'same_skill_segment') {
    // Evidence packs do not yet carry a stable segment id, so this is an intentional session-level approximation.
    const sessionIds = new Set(anchorRefs.map((ref) => ref.sessionId).filter(Boolean));
    return sessionIds.size > 0 ? refs.filter((ref) => sessionIds.has(ref.sessionId)) : refs;
  }
  if (anchorRefs.length === 0) return [];
  const anchorOrders = anchorRefs.map(evidenceRefOrder).filter((order): order is number => order !== undefined);
  if (anchorOrders.length === 0) return [];
  const anchorOrder = Math.min(...anchorOrders);
  const anchorSessionIds = new Set(anchorRefs.map((ref) => ref.sessionId).filter(Boolean));
  return refs.filter((ref) => {
    if (anchorSessionIds.size > 0 && !anchorSessionIds.has(ref.sessionId)) return false;
    const order = evidenceRefOrder(ref);
    return order !== undefined && order >= anchorOrder;
  });
}

function evidenceRefOrder(ref: SkillRuntimeEvidencePackRef): number | undefined {
  return ref.logicalMessageIndex ?? ref.messageIndex ?? ref.sourceLineIndex;
}

function inferRuntimeNodeStatusWithoutTriggers(node: RuntimeStandardNode, matches: Map<string, RuntimeSignalMatch>): RuntimeNodeVerdict {
  const expected = node.expectedSignals.flatMap((signal) => matches.get(signalKey('expectedSignals', signal.id))?.refs ?? []);
  const failure = node.failureSignals.flatMap((signal) => matches.get(signalKey('failureSignals', signal.id))?.refs ?? []);
  const forbidden = node.forbiddenSignals.flatMap((signal) => matches.get(signalKey('forbiddenSignals', signal.id))?.refs ?? []);
  const condition = node.conditionSignals.flatMap((signal) => matches.get(signalKey('conditionSignals', signal.id))?.refs ?? []);
  if (forbidden.length > 0 || failure.length > 0) return 'violated';
  if (node.conditionSignals.length > 0 && condition.length === 0) return 'unknown';
  if (expected.length > 0) return 'passed';
  if (node.expectedSignals.length > 0) return 'missed';
  return 'unknown';
}

function aggregateRuntimeNodeStatuses(statuses: RuntimeNodeVerdict[]): RuntimeNodeVerdict {
  const priority: Record<RuntimeNodeVerdict, number> = {
    violated: 5,
    degraded: 4,
    unknown: 3,
    passed: 2,
    missed: 1,
  };
  return statuses.slice().sort((a, b) => priority[b] - priority[a])[0] ?? 'unknown';
}

function buildRuntimeNodeReason(node: RuntimeStandardNode, status: RuntimeNodeVerdict, matchedSignals: RuntimeSignalMatch[]): string {
  if (matchedSignals.length === 0) return runtimeNodeStatusReason(status);
  const labels = matchedSignals.slice(0, 4).map((match) => signalDisplayName(match.signal)).join('、');
  if (status === 'passed') return `命中运行证据：${labels}。`;
  if (status === 'violated') return `命中失败或禁止证据：${labels}。`;
  if (status === 'missed') return `未命中节点要求的关键证据：${node.title}。`;
  return `${runtimeNodeStatusReason(status)} 命中证据：${labels}。`;
}

function runtimeNodeStatusReason(status: RuntimeNodeVerdict): string {
  if (status === 'passed') return '已看到对应运行证据。';
  if (status === 'missed') return '未发现调用。';
  if (status === 'violated') return '观察到失败或禁止信号。';
  if (status === 'degraded') return '证据质量不足，不能强判。';
  return '未发现调用。';
}

function signalDisplayName(signal: RuntimeSignal): string {
  const value = Array.isArray(signal.value) ? signal.value.join('/') : signal.value;
  return `${signal.type}:${value}`;
}

function signalKey(group: RuntimeSignalGroupName, signalId: string): string {
  return `${group}:${signalId}`;
}

function dedupeMatchedSignals(signals: RuntimeMatchedSignal[]): RuntimeMatchedSignal[] {
  const out = new Map<string, RuntimeMatchedSignal>();
  for (const signal of signals) {
    const key = `${signal.signalGroup}:${signal.signalId}`;
    const existing = out.get(key);
    out.set(key, existing
      ? { ...existing, evidenceRefs: dedupeEvidenceRefs([...existing.evidenceRefs, ...signal.evidenceRefs]) }
      : signal);
  }
  return Array.from(out.values()).slice(0, 60);
}

function dedupeEvidenceRefs(refs: SkillRuntimeEvidencePackRef[]): SkillRuntimeEvidencePackRef[] {
  const out = new Map<string, SkillRuntimeEvidencePackRef>();
  for (const ref of refs) out.set(ref.id, ref);
  return Array.from(out.values());
}
