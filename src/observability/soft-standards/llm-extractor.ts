import { createExecutor } from '../../executors/index.js';
import { readPromptDocument } from '../../shared/llm-prompts/index.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import type {
  ObservationSkillChain,
  SkillRuntimeEvidencePack,
  SkillRuntimeEvidencePackNode,
} from '../skill-health/skill-chain.js';
import {
  PROMPTS_DIR,
  SOFT_STANDARD_PROMPT_ID,
  SOFT_STANDARD_PROMPT_VERSION,
} from './constants.js';
import {
  hashText,
  loadSkillDerivedStandards,
  markStale,
  SKILL_DERIVED_STANDARDS_SCHEMA_VERSION,
  skillDerivedStandardsPath,
} from './skill-standards-store.js';
import { evaluateRuntimeStandardNodes } from './runtime-evaluator.js';
import type {
  ExtractSkillSoftStandardsOptions,
  LlmEnhancedChecklistStatus,
  LlmEnhancedSkillType,
  LlmEnhancedUserFeeling,
  LlmEnhancedVerdict,
  RuntimeNodeVerdict,
  RuntimeSignal,
  RuntimeSignalOp,
  RuntimeSignalRef,
  RuntimeSignalType,
  RuntimeStandardNode,
  RuntimeStandardNodeKind,
  RuntimeStandardNodeSourceHint,
  RuntimeTrigger,
  RuntimeTriggerWindowScope,
  SkillDerivedStandard,
  SkillDerivedStandards,
  SkillLlmEnhancedReviewSections,
  SkillLlmTypeSpecificChecklistItem,
} from './types.js';

export async function extractSkillSoftStandards(options: ExtractSkillSoftStandardsOptions): Promise<SkillDerivedStandards> {
  const { observationsDir, skillChain } = options;
  const model = options.model;
  const executorName = options.executorName;
  const generatedAt = options.now || new Date().toISOString();
  const path = skillDerivedStandardsPath(observationsDir, skillChain.skillName);
  const sourceHash = skillChain.definition.content ? hashText(skillChain.definition.content) : undefined;
  const runtimeEvidenceHash = options.runtimeEvidence ? hashText(JSON.stringify(options.runtimeEvidence)) : undefined;
  const existing = loadSkillDerivedStandards(observationsDir)[skillChain.skillName];
  const promptDocument = readPromptTemplate();
  const hasReviewedStandards = existing?.standards.some((item) =>
    item.status === 'author_confirmed' || item.status === 'rejected' || item.status === 'stale'
  ) ?? false;
  const compatibleCache = existing
    && existing.promptId === SOFT_STANDARD_PROMPT_ID
    && existing.promptVersion === SOFT_STANDARD_PROMPT_VERSION
    && existing.promptHash === promptDocument.hash;
  if (existing && hasReviewedStandards && !options.refresh) {
    const stale = markStale(existing, generatedAt);
    writeJsonFileAtomic(path, stale);
    return stale;
  }
  if (compatibleCache && !options.refresh && existing.sourceHash === sourceHash && existing.runtimeEvidenceHash === runtimeEvidenceHash) return existing;

  const needsHardRules = !skillChain.healthCheck.hardRules.declared;
  const needsWorkflows = !skillChain.healthCheck.workflows.declared;
  const prompt = buildSoftStandardPrompt(skillChain, { needsHardRules, needsWorkflows }, options.runtimeEvidence);
  const executor = options.executor ?? createExecutor(executorName);
  const result = await executor({
    model,
    system: promptDocument.body,
    prompt,
    timeoutMs: 300_000,
    lean: true,
  });
  const parsedReview = parseLlmEnhancedReviewOutput(result.output || '');
  const runtimeEvidencePack = options.runtimeEvidence?.skillRuntimeEvidencePack ?? skillChain.runtime.evidencePack;
  const enhancedReview = withRequiredStandardOwnerSuggestions(
    attachRuntimeNodeResults(parsedReview, runtimeEvidencePack),
    { needsHardRules, needsWorkflows },
    runtimeEvidencePack,
  );
  const standards = standardsFromEnhancedReview(enhancedReview).map((item) => ({
    ...item,
    status: 'pending_review' as const,
    source: 'llm_soft_standard' as const,
  }));
  const record: SkillDerivedStandards = {
    kind: 'observe-skill-derived-standards',
    schemaVersion: SKILL_DERIVED_STANDARDS_SCHEMA_VERSION,
    skillName: skillChain.skillName,
    sourceSkillPath: skillChain.definition.path,
    sourceHash,
    generatedAt,
    model,
    executor: executorName,
    promptId: SOFT_STANDARD_PROMPT_ID,
    promptVersion: SOFT_STANDARD_PROMPT_VERSION,
    promptHash: promptDocument.hash,
    runtimeEvidenceHash,
    enhancedReview,
    standards,
  };
  writeJsonFileAtomic(path, record);
  return record;
}

function buildSoftStandardPrompt(
  skillChain: ObservationSkillChain,
  flags: { needsHardRules: boolean; needsWorkflows: boolean },
  runtimeEvidence?: ExtractSkillSoftStandardsOptions['runtimeEvidence'],
): string {
  const evidencePack = runtimeEvidence?.skillRuntimeEvidencePack ?? skillChain.runtime.evidencePack;
  const resolvedRuntimeEvidence = runtimeEvidence ?? {
    goalSlices: [],
    userMessages: [],
    assistantMessages: [],
    artifactCandidates: [],
    toolCalls: [],
    findings: [],
    skillRuntimeEvidencePack: evidencePack,
  };
  return JSON.stringify({
    task: 'llm_enhanced_review',
    promptId: SOFT_STANDARD_PROMPT_ID,
    promptVersion: SOFT_STANDARD_PROMPT_VERSION,
    skillName: skillChain.skillName,
    needsHardRules: flags.needsHardRules,
    needsWorkflows: flags.needsWorkflows,
    skillContent: skillChain.definition.content ?? '',
    runtimeSummary: skillChain.runtime.summary,
    availableNodeEvidenceIds: availableNodeEvidenceSummaries(evidencePack),
    runtimeEvidence: resolvedRuntimeEvidence,
  }, null, 2);
}

function availableNodeEvidenceSummaries(evidencePack?: SkillRuntimeEvidencePack): Array<{
  nodeId: string;
  nodeKind: SkillRuntimeEvidencePackNode['nodeKind'];
  title: string;
  expectation: string;
  candidateEvidenceSnippets: string[];
}> {
  return (evidencePack?.nodeEvidence ?? []).slice(0, 40).map((node) => ({
    nodeId: node.nodeId,
    nodeKind: node.nodeKind,
    title: node.title.slice(0, 120),
    expectation: node.expectation.slice(0, 240),
    candidateEvidenceSnippets: node.candidateEvidenceSnippets.slice(0, 3).map((snippet) => snippet.slice(0, 180)),
  }));
}

function readPromptTemplate() {
  return readPromptDocument({
    dir: PROMPTS_DIR,
    fileName: 'llm-enhanced-review.prompt.md',
    id: SOFT_STANDARD_PROMPT_ID,
    version: SOFT_STANDARD_PROMPT_VERSION,
  });
}

function parseLlmEnhancedReviewOutput(output: string): SkillLlmEnhancedReviewSections {
  const parsed = parseJsonObject(output);
  return {
    skillType: normalizeSkillType(parsed?.skillType),
    extractedStandards: normalizeExtractedStandards(parsed?.extractedStandards, parsed?.standards),
    userGoal: normalizeUserGoal(parsed?.userGoal),
    skillDeclaredGoal: normalizeSkillDeclaredGoal(parsed?.skillDeclaredGoal),
    runtimeAssessment: normalizeRuntimeAssessment(parsed?.runtimeAssessment),
    typeSpecificAssessment: normalizeTypeSpecificAssessment(parsed?.typeSpecificAssessment),
    userExperienceSignals: normalizeUserExperienceSignals(parsed?.userExperienceSignals),
    reviewerSummary: typeof parsed?.reviewerSummary === 'string' ? parsed.reviewerSummary.slice(0, 1200) : undefined,
    ownerSuggestions: normalizeOwnerSuggestions(parsed?.ownerSuggestions),
  };
}

function withRequiredStandardOwnerSuggestions(
  review: SkillLlmEnhancedReviewSections,
  flags: { needsHardRules: boolean; needsWorkflows: boolean },
  evidencePack?: SkillRuntimeEvidencePack,
): SkillLlmEnhancedReviewSections {
  const existing = review.ownerSuggestions ?? [];
  const hasSuggestion = (pattern: RegExp): boolean =>
    existing.some((item) => pattern.test([item.title, item.body, item.acceptanceCriteria].filter(Boolean).join('\n')));
  const required: typeof existing = [];
  if (flags.needsHardRules && !hasSuggestion(/hard\s*rules?|hardRule|硬性规则|硬规则|规则声明/i)) {
    required.push({
      title: '补充标准化硬性规则声明',
      body: '在 SKILL.md 中把必须执行、禁止执行、失败时必须停止或回退的约束写成可复盘的 hardRules。这样报告能区分“能力没有规则”与“规则已声明但运行未遵守”。',
      evidence: ['needsHardRules=true'],
      acceptanceCriteria: '下次评测中，定义链路能识别到 hardRules，报告不再提示缺少标准化硬性规则声明。',
    });
  }
  if (flags.needsWorkflows && !hasSuggestion(/workflow|工作流|流程|完成标准|产物标准|completion|artifact/i)) {
    required.push({
      title: '补充标准化流程和完成标准',
      body: '在 SKILL.md 中声明标准 workflow、完成标准和产物标准，把前置检查、核心执行、失败阻断、最终交付写成可观测步骤。这样 LLM 增强复盘能按声明流程判断是否跑完整。',
      evidence: ['needsWorkflows=true'],
      acceptanceCriteria: '下次评测中，定义链路能识别到 workflow / completionCriteria / artifactCriteria，运行报告能按步骤展示执行情况。',
    });
  }
  if (shouldSuggestFeedbackContract(review, evidencePack) && !hasSuggestion(/feedback|adopt|reject|useful|thumbs?|反馈|采用|弃用|点赞|点踩|简评|评价/i)) {
    required.push({
      title: '补充用户反馈采集点',
      body: '在产物交付或人工复盘入口中补充轻量反馈契约，例如采用 / 弃用、有用 / 无用、点赞 / 点踩或一句话简评。这样线上观测可以把用户反馈关联到具体 session、skill 调用、产物、workflow 和规则证据，而不是让报告自行猜业务结果好坏。',
      evidence: ['feedbackContract=missing_or_unspecified'],
      acceptanceCriteria: '下次线上观测中，产物或复盘记录能看到采用 / 弃用或简评等反馈字段，并可回溯到对应 session、artifact 和 skill invocation。',
    });
  }
  return {
    ...review,
    ownerSuggestions: [...required, ...existing]
      .filter((item) => item.title || item.body || item.acceptanceCriteria)
      .filter((item, index, arr) => {
        const key = [item.title, item.body, item.acceptanceCriteria].filter(Boolean).join('\u0000');
        return arr.findIndex((candidate) => [candidate.title, candidate.body, candidate.acceptanceCriteria].filter(Boolean).join('\u0000') === key) === index;
      })
      .slice(0, 10),
  };
}

function shouldSuggestFeedbackContract(review: SkillLlmEnhancedReviewSections, evidencePack?: SkillRuntimeEvidencePack): boolean {
  const feedbackCount = evidencePack?.runtimeEvidence.userFeedback.length ?? 0;
  if (feedbackCount > 0) return false;
  const hasUserFacingOutput = review.runtimeAssessment?.goalSatisfaction === 'passed'
    || review.runtimeAssessment?.artifactGoalMatch === 'passed'
    || (evidencePack?.runtimeEvidence.artifacts.length ?? 0) > 0;
  const typeNeedsClosure = review.skillType === 'router'
    || review.skillType === 'delegation'
    || review.skillType === 'workflow_owner';
  return hasUserFacingOutput || typeNeedsClosure;
}

function standardsFromEnhancedReview(review: SkillLlmEnhancedReviewSections): Array<Omit<SkillDerivedStandard, 'status' | 'source'>> {
  const standards = review.extractedStandards;
  if (!standards) return [];
  const raw = [
    ...standards.hardrules.map((item) => ({ ...item, kind: 'hard_rule_candidate' as const })),
    ...standards.workflows.map((item) => ({ ...item, kind: 'workflow_candidate' as const })),
    ...standards.completionCriteria.map((item) => ({ ...item, kind: 'workflow_candidate' as const })),
    ...standards.artifactCriteria.map((item) => ({ ...item, kind: 'workflow_candidate' as const })),
  ];
  return raw.map((item, index) => normalizeStandard(item, index)).filter((item): item is Omit<SkillDerivedStandard, 'status' | 'source'> => Boolean(item));
}

function parseJsonObject(output: string): { [key: string]: unknown; standards?: unknown[] } | null {
  try {
    return JSON.parse(output) as { [key: string]: unknown; standards?: unknown[] };
  } catch {
    const match = output.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as { [key: string]: unknown; standards?: unknown[] };
    } catch {
      return null;
    }
  }
}

function normalizeSkillType(value: unknown): LlmEnhancedSkillType | undefined {
  return value === 'router' || value === 'delegation' || value === 'executor' || value === 'advisory' || value === 'workflow_owner' || value === 'unknown'
    ? value
    : undefined;
}

function normalizeExtractedStandards(
  value: unknown,
  legacyStandards: unknown,
): SkillLlmEnhancedReviewSections['extractedStandards'] | undefined {
  if (!value || typeof value !== 'object') {
    if (!Array.isArray(legacyStandards)) return undefined;
    return {
      hardrules: legacyStandards.map((item, index) => normalizeStandardSectionItem(item, index)).filter((item): item is Omit<SkillDerivedStandard, 'id' | 'standardKind' | 'status' | 'source'> => Boolean(item)),
      workflows: [],
      completionCriteria: [],
      artifactCriteria: [],
    };
  }
  const record = value as Record<string, unknown>;
  return {
    hardrules: normalizeStandardSection(record.hardrules),
    workflows: normalizeStandardSection(record.workflows),
    completionCriteria: normalizeStandardSection(record.completionCriteria),
    artifactCriteria: normalizeStandardSection(record.artifactCriteria),
    standardNodes: normalizeStandardNodes(record.standardNodes),
  };
}

function normalizeIdentifier(value: unknown, maxLength: number): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, maxLength)
    : '';
}

function normalizeStandardNodes(value: unknown): RuntimeStandardNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rawNodes = value
    .map(normalizeStandardNode)
    .filter((node): node is RuntimeStandardNode => Boolean(node))
    .slice(0, 80);
  const nodeIds = new Set<string>();
  const nodes: RuntimeStandardNode[] = [];
  for (const node of rawNodes) {
    if (nodeIds.has(node.nodeId)) continue;
    nodeIds.add(node.nodeId);
    nodes.push(node);
  }
  const validNodeIds = new Set(nodes.map((node) => node.nodeId));
  for (const node of nodes) {
    if (node.childNodeIds) {
      node.childNodeIds = node.childNodeIds.filter((id, index, arr) =>
        validNodeIds.has(id) && arr.indexOf(id) === index && id !== node.nodeId
      );
    }
  }
  return nodes.length > 0 ? nodes : undefined;
}

function normalizeStandardNode(value: unknown): RuntimeStandardNode | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const nodeId = normalizeIdentifier(item.nodeId, 120);
  const kind = normalizeStandardNodeKind(item.kind);
  const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 180) : '';
  if (!nodeId || !kind || !title) return null;
  return {
    nodeId,
    nodeEvidenceRef: typeof item.nodeEvidenceRef === 'string' ? normalizeIdentifier(item.nodeEvidenceRef, 120) || undefined : undefined,
    nodeKind: kind,
    title,
    description: typeof item.description === 'string' ? item.description.slice(0, 600) : undefined,
    childNodeIds: Array.isArray(item.childNodeIds)
      ? item.childNodeIds.map((entry) => normalizeIdentifier(entry, 120)).filter(Boolean).slice(0, 40)
      : undefined,
    expectedSignals: normalizeRuntimeSignals(item.expectedSignals),
    failureSignals: normalizeRuntimeSignals(item.failureSignals),
    forbiddenSignals: normalizeRuntimeSignals(item.forbiddenSignals),
    conditionSignals: normalizeRuntimeSignals(item.conditionSignals),
    triggers: normalizeRuntimeTriggers(item.triggers),
    sourceHints: normalizeSourceHints(item.sourceHints),
  };
}

function normalizeStandardNodeKind(value: unknown): RuntimeStandardNodeKind | undefined {
  return value === 'workflow' || value === 'hardRule' || value === 'completion' || value === 'artifact' || value === 'stage'
    ? value
    : undefined;
}

export function normalizeRuntimeSignals(value: unknown): RuntimeSignal[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const signals: RuntimeSignal[] = [];
  for (const signal of value
    .map(normalizeRuntimeSignal)
    .filter((signal): signal is RuntimeSignal => Boolean(signal))
  ) {
    if (seen.has(signal.id)) continue;
    seen.add(signal.id);
    signals.push(signal);
    if (signals.length >= 40) break;
  }
  return signals;
}

function normalizeRuntimeSignal(value: unknown): RuntimeSignal | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = normalizeIdentifier(item.id, 80);
  const type = normalizeRuntimeSignalType(item.type);
  if (!id || !type) return null;
  const rawValue = Array.isArray(item.value)
    ? item.value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim().slice(0, 160)).slice(0, 12)
    : typeof item.value === 'string' && item.value.trim()
      ? item.value.trim().slice(0, 240)
      : undefined;
  if (!rawValue || (Array.isArray(rawValue) && rawValue.length === 0)) return null;
  const op = normalizeRuntimeSignalOp(item.op);
  const normalizedOp = normalizeSignalOpForType(type, op, Array.isArray(rawValue));
  if (!normalizedOp) return null;
  return { id, type, value: rawValue, op: normalizedOp };
}

function normalizeRuntimeSignalType(value: unknown): RuntimeSignalType | undefined {
  return value === 'tool_name'
    || value === 'tool_input'
    || value === 'tool_output'
    || value === 'assistant_text'
    || value === 'user_text'
    || value === 'artifact_kind'
    || value === 'artifact_path'
    || value === 'event_kind'
    ? value
    : undefined;
}

function normalizeRuntimeSignalOp(value: unknown): RuntimeSignalOp | undefined {
  return value === 'equals'
    || value === 'contains'
    || value === 'any_of'
    || value === 'fuzzy_contains'
    || value === 'suffix'
    || value === 'glob'
    ? value
    : undefined;
}

export function normalizeSignalOpForType(type: RuntimeSignalType, op: RuntimeSignalOp | undefined, valueIsArray: boolean): RuntimeSignalOp | undefined {
  const fallback: Record<RuntimeSignalType, RuntimeSignalOp> = {
    tool_name: 'equals',
    tool_input: 'contains',
    tool_output: 'contains',
    assistant_text: 'contains',
    user_text: 'contains',
    artifact_kind: 'equals',
    artifact_path: 'contains',
    event_kind: 'equals',
  };
  const selected = op ?? (valueIsArray ? 'any_of' : fallback[type]);
  if (selected === 'any_of') return valueIsArray ? 'any_of' : fallback[type];
  const allowed: Record<RuntimeSignalType, RuntimeSignalOp[]> = {
    tool_name: ['equals', 'contains'],
    tool_input: ['contains', 'fuzzy_contains'],
    tool_output: ['contains', 'fuzzy_contains'],
    assistant_text: ['contains', 'fuzzy_contains'],
    user_text: ['contains', 'fuzzy_contains'],
    artifact_kind: ['equals'],
    artifact_path: ['contains', 'suffix', 'glob'],
    event_kind: ['equals'],
  };
  return allowed[type].includes(selected) ? selected : undefined;
}

export function normalizeRuntimeTriggers(value: unknown): RuntimeTrigger[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeRuntimeTrigger)
    .filter((trigger): trigger is RuntimeTrigger => Boolean(trigger))
    .slice(0, 40);
}

function normalizeRuntimeTrigger(value: unknown): RuntimeTrigger | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const when = normalizeSignalRef(item.when);
  const absence = normalizeSignalRef(item.absence);
  const forbidden = normalizeSignalRef(item.forbidden);
  const required = normalizeSignalRef(item.required);
  if (!when && !absence && !forbidden && !required) return null;
  const actionCount = [absence, forbidden, required].filter(Boolean).length;
  if (actionCount > 1) return null;
  const verdict = normalizeRuntimeNodeVerdict(item.verdict);
  const windowScope = normalizeWindowScope(item.windowScope);
  if (!verdict || !windowScope) return null;
  if (windowScope === 'same_session_after' && !when) return null;
  if (!when && forbidden && !(windowScope === 'anywhere_in_session' || windowScope === 'same_skill_segment')) return null;
  if (!when && absence && !(windowScope === 'anywhere_in_session' || windowScope === 'same_skill_segment')) return null;
  return { ...(when ? { when } : {}), ...(absence ? { absence } : {}), ...(forbidden ? { forbidden } : {}), ...(required ? { required } : {}), verdict, windowScope };
}

function normalizeSignalRef(value: unknown): RuntimeSignalRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const signalGroup = item.signalGroup;
  const signalId = normalizeIdentifier(item.signalId, 80);
  if (!signalId) return undefined;
  if (signalGroup === 'expectedSignals' || signalGroup === 'failureSignals' || signalGroup === 'forbiddenSignals' || signalGroup === 'conditionSignals') {
    return { signalGroup, signalId };
  }
  return undefined;
}

function normalizeRuntimeNodeVerdict(value: unknown): RuntimeNodeVerdict | undefined {
  return value === 'passed' || value === 'missed' || value === 'violated' || value === 'unknown' || value === 'degraded'
    ? value
    : undefined;
}

function normalizeWindowScope(value: unknown): RuntimeTriggerWindowScope | undefined {
  return value === 'same_node'
    || value === 'same_skill_segment'
    || value === 'same_session_after'
    || value === 'anywhere_in_session'
    ? value
    : undefined;
}

function normalizeSourceHints(value: unknown): RuntimeStandardNodeSourceHint[] {
  if (!Array.isArray(value)) return [];
  const hints: Array<RuntimeStandardNodeSourceHint | null> = value.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    const source = item.source === 'skill_md' || item.source === 'frontmatter' || item.source === 'llm_inferred' || item.source === 'template' ? item.source : undefined;
    const snippet = typeof item.snippet === 'string' && item.snippet.trim() ? item.snippet.trim().slice(0, 300) : '';
    if (!source || !snippet) return null;
    return {
      source,
      line: typeof item.line === 'number' && Number.isFinite(item.line) ? Math.max(1, Math.floor(item.line)) : undefined,
      snippet,
    };
  });
  return hints.filter((entry): entry is RuntimeStandardNodeSourceHint => Boolean(entry)).slice(0, 8);
}

function normalizeStandardSection(value: unknown): Array<Omit<SkillDerivedStandard, 'id' | 'standardKind' | 'status' | 'source'>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizeStandardSectionItem(item, index)).filter((item): item is Omit<SkillDerivedStandard, 'id' | 'standardKind' | 'status' | 'source'> => Boolean(item));
}

function normalizeStandardSectionItem(value: unknown, index: number): Omit<SkillDerivedStandard, 'id' | 'standardKind' | 'status' | 'source'> | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return { title: text.slice(0, 160), body: text.slice(0, 600), confidence: 'low', evidence: [] };
  }
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<SkillDerivedStandard>;
  const title = typeof item.title === 'string' && item.title.trim()
    ? item.title.trim()
    : typeof item.body === 'string' && item.body.trim()
      ? item.body.trim().slice(0, 80)
      : `候选标准 ${index + 1}`;
  const body = typeof item.body === 'string' && item.body.trim() ? item.body.trim() : title;
  return {
    title: title.slice(0, 160),
    body: body.slice(0, 600),
    confidence: item.confidence === 'high' || item.confidence === 'medium' || item.confidence === 'low' ? item.confidence : 'low',
    evidence: Array.isArray(item.evidence) ? item.evidence.filter((entry): entry is string => typeof entry === 'string').slice(0, 5) : [],
  };
}

function normalizeUserGoal(value: unknown): SkillLlmEnhancedReviewSections['userGoal'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  return {
    summary: typeof item.summary === 'string' ? item.summary.slice(0, 500) : undefined,
    slots: Array.isArray(item.slots) ? item.slots.filter((entry): entry is string => typeof entry === 'string').slice(0, 12) : [],
    expectedOutcome: typeof item.expectedOutcome === 'string' ? item.expectedOutcome.slice(0, 500) : undefined,
  };
}

function normalizeSkillDeclaredGoal(value: unknown): SkillLlmEnhancedReviewSections['skillDeclaredGoal'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  return {
    summary: typeof item.summary === 'string' ? item.summary.slice(0, 300) : undefined,
    keywords: Array.isArray(item.keywords) ? item.keywords.filter((entry): entry is string => typeof entry === 'string').slice(0, 10) : [],
    expectedOutcomes: Array.isArray(item.expectedOutcomes) ? item.expectedOutcomes.filter((entry): entry is string => typeof entry === 'string').slice(0, 10) : [],
  };
}

function normalizeRuntimeAssessment(value: unknown): SkillLlmEnhancedReviewSections['runtimeAssessment'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  return {
    goalSatisfaction: normalizeVerdict(item.goalSatisfaction),
    declaredBehaviorFit: normalizeVerdict(item.declaredBehaviorFit),
    artifactGoalMatch: normalizeVerdict(item.artifactGoalMatch),
    userFeeling: normalizeUserFeeling(item.userFeeling),
  };
}

function normalizeTypeSpecificAssessment(value: unknown): SkillLlmEnhancedReviewSections['typeSpecificAssessment'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const rawChecklist = Array.isArray(item.checklist) ? item.checklist : [];
  const checklist = rawChecklist
    .map(normalizeTypeSpecificChecklistItem)
    .filter((entry): entry is SkillLlmTypeSpecificChecklistItem => Boolean(entry))
    .slice(0, 12);
  if (checklist.length === 0 && typeof item.summary !== 'string') return undefined;
  return {
    checklist,
    summary: typeof item.summary === 'string' ? item.summary.slice(0, 800) : undefined,
  };
}

function normalizeTypeSpecificChecklistItem(value: unknown): SkillLlmTypeSpecificChecklistItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const key = typeof item.key === 'string' && item.key.trim()
    ? item.key.trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80)
    : '';
  const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 120) : '';
  const status = normalizeChecklistStatus(item.status);
  if (!key || !label || !status) return null;
  return {
    key,
    label,
    status,
    reason: typeof item.reason === 'string' ? item.reason.slice(0, 500) : undefined,
    evidence: Array.isArray(item.evidence) ? item.evidence.filter((it): it is string => typeof it === 'string').slice(0, 5) : undefined,
    suggestionKey: typeof item.suggestionKey === 'string' ? item.suggestionKey.slice(0, 120) : undefined,
  };
}

function attachRuntimeNodeResults(
  review: SkillLlmEnhancedReviewSections,
  evidencePack?: SkillRuntimeEvidencePack,
): SkillLlmEnhancedReviewSections {
  const standardNodes = runtimeStandardNodesWithFallback(review);
  if (standardNodes.length === 0 || !evidencePack) return review;
  const nodeResults = evaluateRuntimeStandardNodes(standardNodes, evidencePack);
  return {
    ...review,
    extractedStandards: {
      hardrules: review.extractedStandards?.hardrules ?? [],
      workflows: review.extractedStandards?.workflows ?? [],
      completionCriteria: review.extractedStandards?.completionCriteria ?? [],
      artifactCriteria: review.extractedStandards?.artifactCriteria ?? [],
      standardNodes,
    },
    runtimeNodeResults: {
      summary: nodeResults.length > 0
        ? `规则层已复核 ${nodeResults.filter((node) => node.nodeKind !== 'stage').length} 个流程/规则节点。`
        : '没有可复核的流程/规则节点。',
      nodes: nodeResults,
    },
  };
}

function runtimeStandardNodesWithFallback(review: SkillLlmEnhancedReviewSections): RuntimeStandardNode[] {
  const nodes = review.extractedStandards?.standardNodes ?? [];
  if (nodes.length > 0) return nodes;
  if (review.skillType === 'workflow_owner') return WORKFLOW_OWNER_FALLBACK_STANDARD_NODES;
  return [];
}

const WORKFLOW_OWNER_FALLBACK_STANDARD_NODES: RuntimeStandardNode[] = [
  workflowOwnerStage('stage_intake', '输入理解', ['stage_intake_goal']),
  workflowOwnerNode('stage_intake_goal', 'workflow', '识别用户目标', [
    signal('user_goal_text', 'user_text', ['需求', '目标', '帮我', '请', '需要'], 'any_of'),
  ]),
  workflowOwnerStage('stage_lookup', '标准查询', ['stage_lookup_reference']),
  workflowOwnerNode('stage_lookup_reference', 'workflow', '查询或读取标准材料', [
    signal('reference_tool', 'tool_name', ['Read', 'Grep', 'Glob', 'skylark_doc_detail'], 'any_of'),
  ]),
  workflowOwnerStage('stage_delegate', '执行推进', ['stage_delegate_execution']),
  workflowOwnerNode('stage_delegate_execution', 'workflow', '推进执行或委派下游', [
    signal('delegate_tool', 'tool_name', ['Task', 'Bash', 'Skill'], 'any_of'),
  ]),
  workflowOwnerStage('stage_collect', '状态回收', ['stage_collect_status']),
  workflowOwnerNode('stage_collect_status', 'completion', '回收阶段状态', [
    signal('status_text', 'assistant_text', ['进度', '状态', '完成', '结果'], 'any_of'),
  ]),
  workflowOwnerStage('stage_report', '结果回传', ['stage_report_result']),
  workflowOwnerNode('stage_report_result', 'completion', '向用户回传结果', [
    signal('result_text', 'assistant_text', ['完成', '结果如下', '已生成', '已写入', '结论'], 'any_of'),
  ]),
];

function workflowOwnerStage(nodeId: string, title: string, childNodeIds: string[]): RuntimeStandardNode {
  return {
    nodeId,
    nodeKind: 'stage',
    title,
    description: 'workflow_owner 通用兜底阶段；当 SKILL.md 没有可抽取阶段时使用。',
    childNodeIds,
    expectedSignals: [],
    failureSignals: [],
    forbiddenSignals: [],
    conditionSignals: [],
    triggers: [],
    sourceHints: [{ source: 'template', snippet: 'workflow_owner fallback stage template' }],
  };
}

function workflowOwnerNode(
  nodeId: string,
  kind: RuntimeStandardNodeKind,
  title: string,
  expectedSignals: RuntimeSignal[],
): RuntimeStandardNode {
  return {
    nodeId,
    nodeKind: kind,
    title,
    expectedSignals,
    failureSignals: [],
    forbiddenSignals: [],
    conditionSignals: [],
    triggers: expectedSignals.map((item) => ({
      required: { signalGroup: 'expectedSignals', signalId: item.id },
      verdict: 'passed' as const,
      windowScope: 'same_skill_segment' as const,
    })),
    sourceHints: [{ source: 'template', snippet: 'workflow_owner fallback node template' }],
  };
}

function signal(id: string, type: RuntimeSignalType, value: string | string[], op: RuntimeSignalOp): RuntimeSignal {
  return { id, type, value, op };
}

function normalizeChecklistStatus(value: unknown): LlmEnhancedChecklistStatus | undefined {
  return value === 'passed' || value === 'failed' || value === 'unknown' || value === 'degraded' || value === 'not_applicable'
    ? value
    : undefined;
}

function normalizeUserExperienceSignals(value: unknown): SkillLlmEnhancedReviewSections['userExperienceSignals'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  return {
    useful: normalizeVerdict(item.useful),
    followUp: normalizeVerdict(item.followUp),
    correction: normalizeVerdict(item.correction),
    negativeFeedback: normalizeVerdict(item.negativeFeedback),
    interruption: normalizeVerdict(item.interruption),
    frustration: normalizeVerdict(item.frustration),
  };
}

function normalizeVerdict(value: unknown): LlmEnhancedVerdict | undefined {
  return value === 'passed' || value === 'failed' || value === 'unknown' ? value : undefined;
}

function normalizeUserFeeling(value: unknown): LlmEnhancedUserFeeling | undefined {
  return value === 'positive' || value === 'neutral' || value === 'negative' || value === 'frustrated' ? value : undefined;
}

function normalizeOwnerSuggestions(value: unknown): SkillLlmEnhancedReviewSections['ownerSuggestions'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 10).map((entry) => {
    if (typeof entry === 'string') return { title: entry.slice(0, 160), body: entry.slice(0, 800) };
    if (!entry || typeof entry !== 'object') return {};
    const item = entry as Record<string, unknown>;
    return {
      title: typeof item.title === 'string' ? item.title.slice(0, 160) : undefined,
      body: typeof item.body === 'string' ? item.body.slice(0, 1000) : undefined,
      evidence: Array.isArray(item.evidence) ? item.evidence.filter((it): it is string => typeof it === 'string').slice(0, 5) : undefined,
      acceptanceCriteria: typeof item.acceptanceCriteria === 'string' ? item.acceptanceCriteria.slice(0, 600) : undefined,
      checklistItemKey: typeof item.checklistItemKey === 'string' ? item.checklistItemKey.slice(0, 120) : undefined,
    };
  });
}

function normalizeStandard(value: unknown, index: number): Omit<SkillDerivedStandard, 'status' | 'source'> | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const kind = item.kind === 'workflow_candidate' ? 'workflow_candidate' : item.kind === 'hard_rule_candidate' ? 'hard_rule_candidate' : undefined;
  if (!kind || typeof item.title !== 'string' || typeof item.body !== 'string') return null;
  const stable = [kind, item.title, item.body].join('\u0000');
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `soft-${hashText(stable).slice(0, 12)}-${index}`,
    standardKind: kind,
    title: item.title.slice(0, 160),
    body: item.body.slice(0, 600),
    confidence: item.confidence === 'high' || item.confidence === 'medium' || item.confidence === 'low' ? item.confidence : 'low',
    evidence: Array.isArray(item.evidence) ? item.evidence.filter((entry): entry is string => typeof entry === 'string').slice(0, 5) : [],
  };
}
