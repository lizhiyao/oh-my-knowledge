import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  extractMarkdownStepWorkflows,
  validateSkillHardRules,
  validateSkillWorkflows,
} from '../skill-definition/hard-rules.js';
import type { SkillHardRule, SkillWorkflow } from '../skill-definition/contracts.js';
import { incrementRecordCount } from '../shared/record-count.js';
import type {
  ExperienceInvocation,
  ExperienceTimelineEvent,
  ObservationExperienceReport,
} from './contracts/experience.js';
import type {
  ObservationRuntimeCheck,
  ObservationRuntimeCheckStatus,
  ObservationSkillChain,
  SkillRuntimeEvidencePack,
  SkillRuntimeEvidencePackNode,
  SkillRuntimeEvidencePackRef,
  SkillRuntimeEvidencePackSourceType,
} from './contracts/skill-chain.js';

export type {
  ObservationRuntimeCheck,
  ObservationRuntimeCheckStatus,
  ObservationSkillChain,
  SkillRuntimeEvidencePack,
  SkillRuntimeEvidencePackNode,
  SkillRuntimeEvidencePackRef,
  SkillRuntimeEvidencePackSourceType,
};

const MAX_SKILL_DEFINITION_CHARS = 12000;

export function buildObservationSkillChains(skillNames: string[], cwd = process.cwd(), experienceReports: ObservationExperienceReport[] = []): Record<string, ObservationSkillChain> {
  const uniqueSkillNames = Array.from(new Set(skillNames.filter(Boolean))).sort();
  return Object.fromEntries(uniqueSkillNames.map((skillName) => [skillName, buildObservationSkillChain(skillName, cwd, experienceReports)]));
}

export function buildObservationSkillChain(skillName: string, cwd = process.cwd(), experienceReports: ObservationExperienceReport[] = []): ObservationSkillChain {
  const path = findSkillMdPath(skillName, cwd);
  if (!path) return emptySkillChain(skillName, experienceReports);
  const content = readFileSync(path, 'utf-8');
  const hardRules = validateSkillHardRules(content);
  const workflows = validateSkillWorkflows(content);
  const markdownWorkflows = workflows.workflows.length > 0 ? [] : extractMarkdownStepWorkflows(content);
  const effectiveWorkflows = workflows.workflows.length > 0 ? workflows.workflows : markdownWorkflows;
  const workflowSource = workflows.workflows.length > 0 ? 'frontmatter' : markdownWorkflows.length > 0 ? 'markdown_headings' : 'none';
  const nodeCount = effectiveWorkflows.reduce((sum, workflow) => sum + workflow.nodes.length, 0);
  const truncated = content.length > MAX_SKILL_DEFINITION_CHARS;
  const runtime = buildRuntimeChecks(skillName, { found: true, path, truncated }, hardRules.rules, effectiveWorkflows, workflowSource, experienceReports);
  return {
    skillName,
    definition: {
      found: true,
      path,
      content: truncated ? content.slice(0, MAX_SKILL_DEFINITION_CHARS) : content,
      truncated,
    },
    healthCheck: {
      source: 'doctor-static-rules',
      hardRules: {
        declared: hardRules.declared,
        valid: hardRules.ok,
        count: hardRules.rules.length,
        rules: hardRules.rules,
        errors: hardRules.errors,
        ...(hardRules.declared ? {} : { advisoryCode: 'hardrules_not_declared' as const }),
      },
      workflows: {
        declared: workflows.declared,
        valid: workflows.ok,
        branchCount: effectiveWorkflows.length,
        nodeCount,
        workflows: effectiveWorkflows,
        errors: workflows.errors,
        source: workflowSource,
        ...(workflows.declared ? {} : { advisoryCode: 'workflows_not_declared' as const }),
      },
    },
    runtime,
  };
}

function emptySkillChain(skillName: string, experienceReports: ObservationExperienceReport[] = []): ObservationSkillChain {
  return {
    skillName,
    definition: { found: false },
    healthCheck: {
      source: 'doctor-static-rules',
      hardRules: { declared: false, valid: true, count: 0, rules: [], errors: [], advisoryCode: 'hardrules_not_declared' },
      workflows: { declared: false, valid: true, branchCount: 0, nodeCount: 0, workflows: [], errors: [], source: 'none', advisoryCode: 'workflows_not_declared' },
    },
    runtime: buildRuntimeChecks(skillName, { found: false }, [], [], 'none', experienceReports),
  };
}

function buildRuntimeChecks(
  skillName: string,
  definition: SkillRuntimeEvidencePack['definition'],
  hardRules: SkillHardRule[],
  workflows: SkillWorkflow[],
  workflowSource: SkillRuntimeEvidencePack['declaredStandards']['workflowNodes'][number]['source'] | 'none',
  experienceReports: ObservationExperienceReport[],
): ObservationSkillChain['runtime'] {
  const invocations = experienceReports.flatMap((report) => report.invocations.filter((invocation) => invocation.skillName === skillName));
  const evidence = runtimeEvidence(invocations);
  const hardRuleChecks = hardRules.map((rule) => evaluateRuntimeText({
    nodeKind: 'hardRule',
    id: rule.id,
    title: rule.rule,
    expectation: rule.expectedBehavior,
  }, evidence));
  const workflowChecks = workflows.flatMap((workflow) =>
    workflow.nodes.map((node) => evaluateRuntimeText({
      nodeKind: 'workflowNode',
      id: `${workflow.id}.${node.id}`,
      title: node.action || `${workflow.id} / ${node.id}`,
      expectation: node.action,
    }, evidence)),
  );
  const all = [...hardRuleChecks, ...workflowChecks];
  const evidencePack = buildSkillRuntimeEvidencePack({
    skillName,
    definition,
    hardRules,
    workflows,
    workflowSource,
    runtimeEvidence: evidence,
    checks: all,
  });
  return {
    supported: true,
    mode: 'deterministic-no-llm',
    message: '仅做非 LLM 的运行时证据检查：只看工具调用、路径、命令、上传等明确证据；抽象语义规则只展开证据，不自动下结论。',
    summary: {
      invocationCount: invocations.length,
      toolCallCount: evidence.toolCallCount,
      toolFailureCount: evidence.toolFailureCount,
      passedCount: all.filter((check) => check.status === 'passed').length,
      attentionCount: all.filter((check) => check.status === 'attention').length,
      manualReviewCount: all.filter((check) => check.status === 'manual_review').length,
    },
    hardRules: hardRuleChecks,
    workflowNodes: workflowChecks,
    evidencePack,
  };
}

function buildSkillRuntimeEvidencePack(input: {
  skillName: string;
  definition: SkillRuntimeEvidencePack['definition'];
  hardRules: SkillHardRule[];
  workflows: SkillWorkflow[];
  workflowSource: SkillRuntimeEvidencePack['declaredStandards']['workflowNodes'][number]['source'] | 'none';
  runtimeEvidence: RuntimeEvidence;
  checks: ObservationRuntimeCheck[];
}): SkillRuntimeEvidencePack {
  const standardById = new Map(input.checks.map((check) => [check.id, check]));
  const allRuntimeRefs = input.runtimeEvidence.events
    .map(eventToEvidencePackRef)
    .filter((ref): ref is SkillRuntimeEvidencePackRef => Boolean(ref));
  const toolCalls = allRuntimeRefs.filter((ref) => ref.sourceType === 'tool_call' || ref.sourceType === 'tool_result').slice(0, 40);
  const assistantMessages = allRuntimeRefs.filter((ref) => ref.sourceType === 'assistant_message').slice(0, 24);
  const userFeedback = allRuntimeRefs.filter((ref) => ref.sourceType === 'user_feedback').slice(0, 24);
  const artifacts = allRuntimeRefs.filter((ref) => ref.sourceType === 'artifact').slice(0, 20);
  const pollutedSourceCount = allRuntimeRefs.filter((ref) => ref.sourceType === 'runtime_context' || ref.sourceType === 'skill_context').length;
  const workflowNodes = input.workflows.flatMap((workflow) => workflow.nodes.map((node) => {
    const id = `${workflow.id}.${node.id}`;
    return {
      id,
      title: node.action || `${workflow.id} / ${node.id}`,
      expectation: node.action,
      workflowId: workflow.id,
      source: input.workflowSource === 'none' ? 'frontmatter' as const : input.workflowSource,
    };
  }));
  const nodeEvidence = [
    ...input.hardRules.map((rule) => nodeEvidenceForCheck({
      check: standardById.get(rule.id),
      nodeId: rule.id,
      nodeKind: 'hardRule' as const,
      title: rule.rule,
      expectation: rule.expectedBehavior,
      refs: allRuntimeRefs,
    })),
    ...workflowNodes.map((node) => nodeEvidenceForCheck({
      check: standardById.get(node.id),
      nodeId: node.id,
      nodeKind: 'workflowNode' as const,
      title: node.title,
      expectation: node.expectation,
      refs: allRuntimeRefs,
    })),
  ];
  const notes: string[] = [];
  if (pollutedSourceCount > 0) notes.push('已识别 runtime context / skill context 污染源，节点复核时不应把这些当业务证据。');
  if (allRuntimeRefs.length === 0) notes.push('没有可用于节点复核的运行证据。');
  return {
    schemaVersion: 1,
    skillName: input.skillName,
    generatedBy: 'deterministic_rule_pack',
    definition: input.definition,
    declaredStandards: {
      hardRules: input.hardRules.map((rule) => ({
        id: rule.id,
        title: rule.rule,
        expectation: rule.expectedBehavior,
        source: 'frontmatter' as const,
      })),
      workflowNodes,
    },
    runtimeEvidence: {
      toolCalls,
      assistantMessages,
      userFeedback,
      artifacts,
    },
    nodeEvidence,
    evidenceQuality: {
      pollutedSourceCount,
      windowTooNarrow: input.runtimeEvidence.events.length > 0 && input.runtimeEvidence.events.length < 3,
      missingRuntimeEvidence: input.runtimeEvidence.events.length === 0,
      notes,
    },
  };
}

function nodeEvidenceForCheck(input: {
  check?: ObservationRuntimeCheck;
  nodeId: string;
  nodeKind: 'workflowNode' | 'hardRule';
  title: string;
  expectation: string;
  refs: SkillRuntimeEvidencePackRef[];
}): SkillRuntimeEvidencePackNode {
  const snippets = input.check?.evidenceSnippets ?? [];
  const matchedRefs = snippets.length > 0
    ? input.refs.filter((ref) => snippets.some((snippet) => snippet.includes(ref.snippet ?? '') || (ref.snippet ?? '').includes(snippet.slice(0, 120)))).slice(0, 5)
    : [];
  return {
    nodeId: input.nodeId,
    nodeKind: input.nodeKind,
    title: input.title,
    expectation: input.expectation,
    deterministicStatus: input.check?.status ?? 'manual_review',
    deterministicReason: input.check?.reason ?? '没有规则层运行检查结果。',
    candidateEvidenceRefs: matchedRefs,
    candidateEvidenceSnippets: snippets.slice(0, 5),
  };
}

interface RuntimeEvidence {
  toolCounts: Record<string, number>;
  toolCallCount: number;
  toolFailureCount: number;
  events: ExperienceTimelineEvent[];
  assistantCallInstanceIds: Set<string>;
  legacyAssistantToolUseIds: Set<string>;
}

function runtimeEvidence(invocations: ExperienceInvocation[]): RuntimeEvidence {
  const toolCounts: Record<string, number> = {};
  const events = invocations.flatMap((invocation) => invocation.timeline ?? []);
  for (const invocation of invocations) {
    for (const [tool, count] of Object.entries(invocation.toolCounts ?? {})) {
      incrementRecordCount(toolCounts, tool, count);
    }
  }
  return {
    toolCounts,
    toolCallCount: invocations.reduce((sum, invocation) => sum + invocation.indicators.toolCallCount, 0),
    toolFailureCount: invocations.reduce((sum, invocation) => sum + invocation.indicators.toolFailureCount, 0),
    events,
    assistantCallInstanceIds: new Set(events
      .filter((event) =>
        event.kind === 'tool_use' && event.role === 'assistant' && event.callInstanceId
      )
      .map((event) => event.callInstanceId as string)),
    legacyAssistantToolUseIds: new Set(events
      .filter((event) =>
        event.kind === 'tool_use'
        && event.role === 'assistant'
        && !event.callInstanceId
        && event.toolUseId
      )
      .map((event) => event.toolUseId as string)),
  };
}

function evaluateRuntimeText(
  base: Pick<ObservationRuntimeCheck, 'nodeKind' | 'id' | 'title' | 'expectation'>,
  evidence: RuntimeEvidence,
): ObservationRuntimeCheck {
  const text = `${base.title}\n${base.expectation}`;
  const lower = text.toLowerCase();
  const forbidden = /不要|禁止|不得|不能|不允许|避免|do not|must not|never|forbid/.test(lower);
  const observable = observableSignals(lower);
  if (observable.length === 0) {
    return {
      ...base,
      status: 'manual_review',
      reason: '这条规则偏语义或质量要求；当前不引入 LLM，只展开证据，不自动判断。',
      evidenceCount: 0,
      evidenceSnippets: [],
    };
  }
  const matched = observable.filter((signal) => signalSeen(signal, evidence));
  const snippets = matched.flatMap((signal) => evidenceSnippetsForSignal(signal, evidence)).slice(0, 5);
  if (forbidden) {
    return {
      ...base,
      status: matched.length > 0 ? 'attention' : 'passed',
      reason: matched.length > 0
        ? `观察到规则禁止的证据：${matched.map(signalLabel).join('、')}，需要关注。`
        : `未观察到规则禁止的运行时证据：${observable.map(signalLabel).join('、')}。`,
      evidenceCount: matched.length,
      evidenceSnippets: snippets,
    };
  }
  return {
    ...base,
    status: matched.length > 0 ? 'passed' : 'attention',
    reason: matched.length > 0
      ? `观察到规则要求的证据：${matched.map(signalLabel).join('、')}。`
      : `未观察到规则要求的证据：${observable.map(signalLabel).join('、')}，需要关注。`,
    evidenceCount: matched.length,
    evidenceSnippets: snippets,
  };
}

type ObservableSignal = 'Read' | 'Grep' | 'Bash' | 'Edit' | 'Write' | 'TodoWrite' | 'upload' | 'git_pull' | 'ask_user' | 'playwright';

function observableSignals(lower: string): ObservableSignal[] {
  const signals = new Set<ObservableSignal>();
  if (/\bread\b|读取|必读|查阅|阅读|参考|领域知识|知识库/.test(lower)) signals.add('Read');
  if (/\bgrep\b|\brg\b|搜索|查找|检索/.test(lower)) signals.add('Grep');
  if (/\bbash\b|\bshell\b|命令|执行脚本/.test(lower)) signals.add('Bash');
  if (/\bedit\b|修改|编辑/.test(lower)) signals.add('Edit');
  if (/\bwrite\b|写入|生成文件|保存文件/.test(lower) || isGenerationWorkflowText(lower)) signals.add('Write');
  if (/\btodo\b|待办|计划/.test(lower)) signals.add('TodoWrite');
  if (/上传|upload|artifacts\/upload|preview_url/.test(lower)) signals.add('upload');
  if (/git pull|同步知识库|更新知识库/.test(lower)) signals.add('git_pull');
  if (/askuserquestion|向用户提问|反问用户|用户确认|确认用户|ask user/.test(lower)) signals.add('ask_user');
  if (/截图|截屏|验证|预览|浏览器|页面检查|playwright|screenshot/.test(lower)) signals.add('playwright');
  return Array.from(signals);
}

function signalSeen(signal: ObservableSignal, evidence: RuntimeEvidence): boolean {
  if (evidence.events.some((event) => eventMatchesSignal(event, signal, evidence))) return true;
  if (evidence.events.length === 0 && isDirectToolSignal(signal) && (evidence.toolCounts[signal] ?? 0) > 0) return true;
  return false;
}

function signalLabel(signal: ObservableSignal): string {
  const labels: Record<ObservableSignal, string> = {
    Read: '读取文件',
    Grep: '搜索/检索',
    Bash: '执行命令',
    Edit: '编辑文件',
    Write: '写入文件',
    TodoWrite: '记录待办',
    upload: '上传产物',
    git_pull: '同步知识库',
    ask_user: '向用户确认',
    playwright: '页面验证/截图',
  };
  return labels[signal];
}

function evidenceSnippetsForSignal(signal: ObservableSignal, evidence: RuntimeEvidence): string[] {
  return evidence.events
    .filter((event) => eventMatchesSignal(event, signal, evidence))
    .map((event) => `${event.label ?? event.kind}: ${event.snippet ?? event.fullText ?? ''}`.trim())
    .filter(Boolean);
}

function isGenerationWorkflowText(lower: string): boolean {
  if (/生成前|创建前/.test(lower)) return false;
  return /(?:生成|创建|产出|输出|写出|保存).*(?:文件|页面|demo|prd|文档|代码|产物|结果)|(?:文件|页面|demo|prd|文档|代码|产物|结果).*(?:生成|创建|输出|保存)|\b(?:generate|create|write)\b/.test(lower);
}

function isDirectToolSignal(signal: ObservableSignal): signal is Extract<ObservableSignal, 'Read' | 'Grep' | 'Bash' | 'Edit' | 'Write' | 'TodoWrite'> {
  return signal === 'Read' || signal === 'Grep' || signal === 'Bash' || signal === 'Edit' || signal === 'Write' || signal === 'TodoWrite';
}

function eventMatchesSignal(event: ExperienceTimelineEvent, signal: ObservableSignal, evidence: RuntimeEvidence): boolean {
  const toolName = (event.toolName ?? '').toLowerCase();
  const text = eventRuntimeText(event);
  if (signal === 'Read') return toolName === 'read' && !isSkillMdSelfRead(text);
  if (signal === 'Grep') return toolName === 'grep' || toolName === 'glob' || /\brg\b|\bgrep\b|搜索|查找|检索/.test(text);
  if (signal === 'Bash') return toolName === 'bash';
  if (signal === 'Edit') return toolName === 'edit' || toolName === 'multiedit';
  if (signal === 'Write') return toolName === 'write';
  if (signal === 'TodoWrite') return toolName === 'todowrite';
  if (signal === 'upload') return isAssistantAuthoredUploadEvent(event, evidence, text);
  if (signal === 'git_pull') return /git pull|同步知识库/.test(text);
  if (signal === 'ask_user') return /askuserquestion|ask user|是否需要|请确认|确认一下/.test(text);
  if (signal === 'playwright') return toolName === 'bash' && /playwright|screenshot|截图|截屏|chromium|浏览器|页面验证/.test(text);
  return false;
}

function eventRuntimeText(event: ExperienceTimelineEvent): string {
  return `${event.toolName ?? ''}\n${event.label ?? ''}\n${event.snippet ?? ''}\n${event.fullText ?? ''}`.toLowerCase();
}

function eventToEvidencePackRef(event: ExperienceTimelineEvent): SkillRuntimeEvidencePackRef | null {
  const snippet = (event.snippet ?? event.fullText ?? '').replace(/\s+/g, ' ').trim();
  if (!snippet) return null;
  const sourceType = evidencePackSourceType(event, snippet);
  return {
    id: event.id,
    kind: event.kind,
    sourceTrace: event.sourceTrace,
    sessionId: event.sessionId,
    messageUuid: event.messageUuid,
    messageIndex: event.messageIndex,
    logicalMessageIndex: event.logicalMessageIndex,
    sourceLineIndex: event.sourceLineIndex,
    callInstanceId: event.callInstanceId,
    toolUseId: event.toolUseId,
    timestamp: event.timestamp,
    role: event.role,
    label: event.label,
    snippet: snippet.slice(0, 800),
    sourceType,
    toolName: event.toolName,
    isError: event.isError,
  };
}

function evidencePackSourceType(event: ExperienceTimelineEvent, snippet: string): SkillRuntimeEvidencePackSourceType {
  const text = `${event.label ?? ''}\n${snippet}`.toLowerCase();
  if (/heartbeat|runtime protocol|当前你在|你在看一个|openclaw heartbeat|current time:/.test(text)) return 'runtime_context';
  if (event.kind === 'skill_context' || isSkillMdSelfRead(text)) return 'skill_context';
  if (event.kind === 'tool_use') return 'tool_call';
  if (event.kind === 'tool_result') return 'tool_result';
  if (event.kind === 'user_message') return 'user_feedback';
  if (/(?:outputs\/runs|\.md\b|\.html\b|https?:\/\/|preview_url|artifact|产物|文档|报告|方案路径|结果文件)/i.test(snippet)) return 'artifact';
  if (event.kind === 'assistant_message') return 'assistant_message';
  return 'unknown';
}

function isAssistantAuthoredUploadEvent(event: ExperienceTimelineEvent, evidence: RuntimeEvidence, text: string): boolean {
  if (!/artifacts\/upload|preview_url|上传成功|\bupload\b/.test(text)) return false;
  if (event.kind === 'tool_use' && event.role === 'assistant') return true;
  if (
    event.kind === 'tool_result'
    && event.role === 'tool'
    && (
      event.callInstanceId
        ? evidence.assistantCallInstanceIds.has(event.callInstanceId)
        : Boolean(event.toolUseId)
          && evidence.legacyAssistantToolUseIds.has(event.toolUseId!)
    )
  ) return true;
  return false;
}

function isSkillMdSelfRead(text: string): boolean {
  return /(?:^|[/"'\\])(?:\.claude|\.codex|\.agents|\.openclaw|workspace)?[/"'\\]*(?:workspace[/"'\\])?skills[/"'\\][^/"'\\]+[/"'\\]skill\.md\b/.test(text)
    || /(?:^|[/"'\\])skills[/"'\\][^/"'\\]+[/"'\\]skill\.md\b/.test(text);
}

const SKILL_SEARCH_MAX_DEPTH = 6;
const SKILL_SEARCH_SKIP_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', '.turbo', '.yarn',
]);
const SKILL_SEARCH_HIDDEN_ALLOWED = new Set([
  '.openclaw', '.claude', '.codex', '.agents',
]);
const skillIndexCache = new Map<string, Map<string, string>>();

function skillSearchHomedirRoots(): string[] {
  return [
    join(homedir(), '.openclaw'),
    join(homedir(), '.claude'),
    join(homedir(), '.codex'),
    join(homedir(), '.agents'),
  ];
}

function walkForSkillsIndex(dir: string, index: Map<string, string>, depthLeft: number): void {
  if (depthLeft <= 0) return;
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name !== 'skills') continue;
    const skillsDir = join(dir, entry.name);
    let skillEntries: Dirent[];
    try { skillEntries = readdirSync(skillsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const skill of skillEntries) {
      if (!skill.isDirectory()) continue;
      if (!/^[A-Za-z0-9_.-]+$/.test(skill.name)) continue;
      if (index.has(skill.name)) continue;
      const candidate = join(skillsDir, skill.name, 'SKILL.md');
      if (existsSync(candidate)) index.set(skill.name, candidate);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'skills') continue;
    if (SKILL_SEARCH_SKIP_NAMES.has(entry.name)) continue;
    if (entry.name.startsWith('.') && !SKILL_SEARCH_HIDDEN_ALLOWED.has(entry.name)) continue;
    walkForSkillsIndex(join(dir, entry.name), index, depthLeft - 1);
  }
}

function buildSkillIndex(cwd: string): Map<string, string> {
  const cacheKey = cwd;
  const cached = skillIndexCache.get(cacheKey);
  if (cached) return cached;
  const index = new Map<string, string>();
  for (const root of [cwd, ...skillSearchHomedirRoots()]) {
    walkForSkillsIndex(root, index, SKILL_SEARCH_MAX_DEPTH);
  }
  skillIndexCache.set(cacheKey, index);
  return index;
}

export function findSkillMdPath(skillName: string, cwd: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(skillName)) return undefined;
  return buildSkillIndex(cwd).get(skillName);
}

export function __resetSkillIndexCacheForTests(): void {
  skillIndexCache.clear();
}
