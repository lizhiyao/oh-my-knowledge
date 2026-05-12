import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  validateSkillHardRules,
  validateSkillWorkflows,
  type SkillHardRule,
  type SkillWorkflow,
} from '../shared/hard-rules.js';
import type { SkillChainAdvisoryCode } from './skill-chain-advisories.js';
import type { ObservationExperienceReport, ExperienceInvocation, ExperienceTimelineEvent } from './experience.js';

export type ObservationRuntimeCheckStatus = 'passed' | 'attention' | 'manual_review';

export interface ObservationRuntimeCheck {
  kind: 'hardRule' | 'workflowNode';
  id: string;
  title: string;
  expectation: string;
  status: ObservationRuntimeCheckStatus;
  reason: string;
  evidenceCount: number;
  evidenceSnippets: string[];
}

export interface ObservationSkillChain {
  skillName: string;
  definition: {
    found: boolean;
    path?: string;
    content?: string;
    truncated?: boolean;
  };
  healthCheck: {
    source: 'doctor-static-rules';
    hardRules: {
      declared: boolean;
      valid: boolean;
      count: number;
      rules: SkillHardRule[];
      errors: string[];
      advisoryCode?: SkillChainAdvisoryCode;
    };
    workflows: {
      declared: boolean;
      valid: boolean;
      branchCount: number;
      nodeCount: number;
      workflows: SkillWorkflow[];
      errors: string[];
      advisoryCode?: SkillChainAdvisoryCode;
    };
  };
  runtime: {
    supported: true;
    mode: 'deterministic-no-llm';
    message: string;
    summary: {
      invocationCount: number;
      toolCallCount: number;
      toolFailureCount: number;
      passedCount: number;
      attentionCount: number;
      manualReviewCount: number;
    };
    hardRules: ObservationRuntimeCheck[];
    workflowNodes: ObservationRuntimeCheck[];
  };
}

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
  const nodeCount = workflows.workflows.reduce((sum, workflow) => sum + workflow.nodes.length, 0);
  const truncated = content.length > MAX_SKILL_DEFINITION_CHARS;
  const runtime = buildRuntimeChecks(skillName, hardRules.rules, workflows.workflows, experienceReports);
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
        branchCount: workflows.workflows.length,
        nodeCount,
        workflows: workflows.workflows,
        errors: workflows.errors,
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
      workflows: { declared: false, valid: true, branchCount: 0, nodeCount: 0, workflows: [], errors: [], advisoryCode: 'workflows_not_declared' },
    },
    runtime: buildRuntimeChecks(skillName, [], [], experienceReports),
  };
}

function buildRuntimeChecks(
  skillName: string,
  hardRules: SkillHardRule[],
  workflows: SkillWorkflow[],
  experienceReports: ObservationExperienceReport[],
): ObservationSkillChain['runtime'] {
  const invocations = experienceReports.flatMap((report) => report.invocations.filter((invocation) => invocation.skillName === skillName));
  const evidence = runtimeEvidence(invocations);
  const hardRuleChecks = hardRules.map((rule) => evaluateRuntimeText({
    kind: 'hardRule',
    id: rule.id,
    title: rule.rule,
    expectation: rule.expectedBehavior,
  }, evidence));
  const workflowChecks = workflows.flatMap((workflow) =>
    workflow.nodes.map((node) => evaluateRuntimeText({
      kind: 'workflowNode',
      id: `${workflow.id}.${node.id}`,
      title: `${workflow.id} / ${node.id}`,
      expectation: node.action,
    }, evidence)),
  );
  const all = [...hardRuleChecks, ...workflowChecks];
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
  };
}

interface RuntimeEvidence {
  toolCounts: Record<string, number>;
  toolCallCount: number;
  toolFailureCount: number;
  events: ExperienceTimelineEvent[];
  allTextLower: string;
}

function runtimeEvidence(invocations: ExperienceInvocation[]): RuntimeEvidence {
  const toolCounts: Record<string, number> = {};
  const events = invocations.flatMap((invocation) => invocation.timeline ?? []);
  for (const invocation of invocations) {
    for (const [tool, count] of Object.entries(invocation.toolCounts ?? {})) {
      toolCounts[tool] = (toolCounts[tool] ?? 0) + count;
    }
  }
  const allTextLower = events
    .map((event) => `${event.toolName ?? ''}\n${event.label ?? ''}\n${event.snippet ?? ''}\n${event.fullText ?? ''}`)
    .join('\n')
    .toLowerCase();
  return {
    toolCounts,
    toolCallCount: invocations.reduce((sum, invocation) => sum + invocation.indicators.toolCallCount, 0),
    toolFailureCount: invocations.reduce((sum, invocation) => sum + invocation.indicators.toolFailureCount, 0),
    events,
    allTextLower,
  };
}

function evaluateRuntimeText(
  base: Pick<ObservationRuntimeCheck, 'kind' | 'id' | 'title' | 'expectation'>,
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

type ObservableSignal = 'Read' | 'Grep' | 'Bash' | 'Edit' | 'Write' | 'TodoWrite' | 'upload' | 'git_pull' | 'ask_user';

function observableSignals(lower: string): ObservableSignal[] {
  const signals = new Set<ObservableSignal>();
  if (/\bread\b|读取|必读|文件|知识库/.test(lower)) signals.add('Read');
  if (/\bgrep\b|\brg\b|搜索|查找|检索/.test(lower)) signals.add('Grep');
  if (/\bbash\b|\bshell\b|命令|执行脚本/.test(lower)) signals.add('Bash');
  if (/\bedit\b|修改|编辑/.test(lower)) signals.add('Edit');
  if (/\bwrite\b|写入|生成文件|保存文件/.test(lower)) signals.add('Write');
  if (/\btodo\b|待办|计划/.test(lower)) signals.add('TodoWrite');
  if (/上传|upload|artifacts\/upload|preview_url/.test(lower)) signals.add('upload');
  if (/git pull|同步知识库|更新知识库/.test(lower)) signals.add('git_pull');
  if (/askuserquestion|向用户提问|反问用户|用户确认|确认用户|ask user/.test(lower)) signals.add('ask_user');
  return Array.from(signals);
}

function signalSeen(signal: ObservableSignal, evidence: RuntimeEvidence): boolean {
  if (signal in evidence.toolCounts && (evidence.toolCounts[signal] ?? 0) > 0) return true;
  const text = evidence.allTextLower;
  if (signal === 'upload') return /artifacts\/upload|preview_url|上传成功|\bupload\b/.test(text);
  if (signal === 'git_pull') return /git pull|同步知识库/.test(text);
  if (signal === 'ask_user') return /askuserquestion|ask user|是否需要|请确认|确认一下/.test(text);
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
  };
  return labels[signal];
}

function evidenceSnippetsForSignal(signal: ObservableSignal, evidence: RuntimeEvidence): string[] {
  const needle = signal.toLowerCase();
  return evidence.events
    .filter((event) => {
      const text = `${event.toolName ?? ''}\n${event.label ?? ''}\n${event.snippet ?? ''}\n${event.fullText ?? ''}`.toLowerCase();
      if (event.toolName === signal) return true;
      if (signal === 'upload') return /artifacts\/upload|preview_url|上传成功|\bupload\b/.test(text);
      if (signal === 'git_pull') return /git pull|同步知识库/.test(text);
      if (signal === 'ask_user') return /askuserquestion|ask user|是否需要|请确认|确认一下/.test(text);
      return text.includes(needle);
    })
    .map((event) => `${event.label ?? event.kind}: ${event.snippet ?? event.fullText ?? ''}`.trim())
    .filter(Boolean);
}

function findSkillMdPath(skillName: string, cwd: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(skillName)) return undefined;
  const candidates = [
    join(cwd, '.claude', 'skills', skillName, 'SKILL.md'),
    join(cwd, '.openclaw', 'workspace', 'skills', skillName, 'SKILL.md'),
    join(cwd, 'workspace', 'skills', skillName, 'SKILL.md'),
    join(cwd, 'skills', skillName, 'SKILL.md'),
    join(homedir(), '.openclaw', 'workspace', 'skills', skillName, 'SKILL.md'),
    join(homedir(), '.claude', 'skills', skillName, 'SKILL.md'),
    join(homedir(), '.codex', 'skills', skillName, 'SKILL.md'),
    join(homedir(), '.agents', 'skills', skillName, 'SKILL.md'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
