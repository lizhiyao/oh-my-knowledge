import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorFn } from '../types/index.js';
import { createExecutor } from '../executors/index.js';
import { readPromptDocument } from '../shared/llm-prompts/index.js';
import { buildObservationSkillChain, type ObservationSkillChain, type SkillRuntimeEvidencePack, type SkillRuntimeEvidencePackNode, type SkillRuntimeEvidencePackRef } from './skill-chain.js';

export const SOFT_STANDARD_PROMPT_ID = 'llm-enhanced-review';
export const SOFT_STANDARD_PROMPT_VERSION = '2026-05-22.v7';
export const DEFAULT_LLM_ENHANCED_REVIEW_MODEL = 'sonnet';

export type SkillDerivedStandardStatus = 'pending_review' | 'author_confirmed' | 'rejected' | 'stale';
export type SkillDerivedStandardKind = 'hard_rule_candidate' | 'workflow_candidate';

export interface SkillDerivedStandard {
  id: string;
  kind: SkillDerivedStandardKind;
  status: SkillDerivedStandardStatus;
  title: string;
  body: string;
  source: 'llm_soft_standard';
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];
}

export interface SkillDerivedStandards {
  kind: 'observe-skill-derived-standards';
  schemaVersion: 1;
  skillName: string;
  sourceSkillPath?: string;
  sourceHash?: string;
  generatedAt: string;
  model: string;
  executor: string;
  promptId: typeof SOFT_STANDARD_PROMPT_ID;
  promptVersion: typeof SOFT_STANDARD_PROMPT_VERSION;
  promptHash?: string;
  runtimeEvidenceHash?: string;
  enhancedReview?: SkillLlmEnhancedReviewSections;
  standards: SkillDerivedStandard[];
}

export interface SkillLlmEnhancedRuntimeEvidence {
  goalSlices: Array<{
    id?: string;
    sessionId?: string;
    inferredUserGoal?: string;
    userMessages?: string[];
  }>;
  userMessages: string[];
  assistantMessages: string[];
  artifactCandidates: string[];
  toolCalls: string[];
  findings: string[];
  skillRuntimeEvidencePack?: SkillRuntimeEvidencePack;
}

export type LlmEnhancedSkillType = 'router' | 'delegation' | 'executor' | 'advisory' | 'workflow_owner' | 'unknown';
export type LlmEnhancedVerdict = 'passed' | 'failed' | 'unknown';
export type LlmEnhancedUserFeeling = 'positive' | 'neutral' | 'negative' | 'frustrated';
export type LlmEnhancedChecklistStatus = 'passed' | 'failed' | 'unknown' | 'degraded' | 'not_applicable';
export type RuntimeStandardNodeKind = 'workflow' | 'hardRule' | 'completion' | 'artifact' | 'stage';
export type RuntimeSignalType =
  | 'tool_name'
  | 'tool_input'
  | 'tool_output'
  | 'assistant_text'
  | 'user_text'
  | 'artifact_kind'
  | 'artifact_path'
  | 'event_kind';
export type RuntimeSignalOp = 'equals' | 'contains' | 'any_of' | 'fuzzy_contains' | 'suffix' | 'glob';
export type RuntimeNodeVerdict = 'passed' | 'missed' | 'violated' | 'unknown' | 'degraded';
export type RuntimeTriggerWindowScope =
  | 'same_node'
  | 'same_skill_segment'
  | 'same_session_after'
  | 'anywhere_in_session';

export interface RuntimeSignal {
  id: string;
  type: RuntimeSignalType;
  value: string | string[];
  op?: RuntimeSignalOp;
}

export interface RuntimeSignalRef {
  signalGroup: 'expectedSignals' | 'failureSignals' | 'forbiddenSignals' | 'conditionSignals';
  signalId: string;
}

export interface RuntimeTrigger {
  when?: RuntimeSignalRef;
  absence?: RuntimeSignalRef;
  forbidden?: RuntimeSignalRef;
  required?: RuntimeSignalRef;
  verdict: RuntimeNodeVerdict;
  windowScope: RuntimeTriggerWindowScope;
}

export interface RuntimeStandardNodeSourceHint {
  source: 'skill_md' | 'frontmatter' | 'llm_inferred' | 'template';
  line?: number;
  snippet: string;
}

export interface RuntimeStandardNode {
  nodeId: string;
  nodeEvidenceRef?: string;
  kind: RuntimeStandardNodeKind;
  title: string;
  description?: string;
  childNodeIds?: string[];
  expectedSignals: RuntimeSignal[];
  failureSignals: RuntimeSignal[];
  forbiddenSignals: RuntimeSignal[];
  conditionSignals: RuntimeSignal[];
  triggers: RuntimeTrigger[];
  sourceHints: RuntimeStandardNodeSourceHint[];
}

export interface RuntimeMatchedSignal {
  signalId: string;
  signalType: RuntimeSignalType;
  signalGroup: RuntimeSignalRef['signalGroup'];
  evidenceRefs: SkillRuntimeEvidencePackRef[];
}

export interface RuntimeNodeResult {
  nodeId: string;
  kind: RuntimeStandardNodeKind;
  title: string;
  status: RuntimeNodeVerdict;
  matchedSignals: RuntimeMatchedSignal[];
  evidenceRefs: SkillRuntimeEvidencePackRef[];
  reason: string;
}

export interface SkillLlmTypeSpecificChecklistItem {
  key: string;
  label: string;
  status: LlmEnhancedChecklistStatus;
  reason?: string;
  evidence?: string[];
  suggestionKey?: string;
}

export interface SkillLlmRuntimeNodeAssessment {
  nodeId: string;
  kind: 'workflowNode' | 'hardRule';
  status: LlmEnhancedChecklistStatus;
  reason?: string;
  evidence?: string[];
  suggestionKey?: string;
}

export interface SkillLlmEnhancedReviewSections {
  skillType?: LlmEnhancedSkillType;
  extractedStandards?: {
    hardrules: Array<Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'>>;
    workflows: Array<Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'>>;
    completionCriteria: Array<Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'>>;
    artifactCriteria: Array<Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'>>;
    standardNodes?: RuntimeStandardNode[];
  };
  userGoal?: {
    summary?: string;
    slots: string[];
    expectedOutcome?: string;
  };
  skillDeclaredGoal?: {
    summary?: string;
    keywords: string[];
    expectedOutcomes: string[];
  };
  runtimeAssessment?: {
    goalSatisfaction?: LlmEnhancedVerdict;
    declaredBehaviorFit?: LlmEnhancedVerdict;
    artifactGoalMatch?: LlmEnhancedVerdict;
    userFeeling?: LlmEnhancedUserFeeling;
  };
  typeSpecificAssessment?: {
    checklist: SkillLlmTypeSpecificChecklistItem[];
    summary?: string;
  };
  /** Kept only so older persisted reports with LLM node verdicts can still be read. */
  runtimeNodeAssessment?: {
    summary?: string;
    nodes: SkillLlmRuntimeNodeAssessment[];
  };
  runtimeNodeResults?: {
    summary?: string;
    nodes: RuntimeNodeResult[];
  };
  userExperienceSignals?: {
    useful?: LlmEnhancedVerdict;
    followUp?: LlmEnhancedVerdict;
    correction?: LlmEnhancedVerdict;
    negativeFeedback?: LlmEnhancedVerdict;
    interruption?: LlmEnhancedVerdict;
    frustration?: LlmEnhancedVerdict;
  };
  reviewerSummary?: string;
  ownerSuggestions?: Array<{
    title?: string;
    body?: string;
    evidence?: string[];
    acceptanceCriteria?: string;
    checklistItemKey?: string;
  }>;
}

export type ResolvedSkillStandardSource = 'frontmatter' | 'confirmed_soft' | 'pending_soft';
export type ResolvedSkillStandardKind = 'hard_rule' | 'workflow';

export interface ResolvedSkillStandard {
  id: string;
  kind: ResolvedSkillStandardKind;
  title: string;
  body: string;
  source: ResolvedSkillStandardSource;
  status?: SkillDerivedStandardStatus;
  confidence?: SkillDerivedStandard['confidence'];
  evidence?: string[];
}

export interface ResolvedSkillStandards {
  skillName: string;
  active: ResolvedSkillStandard[];
  candidates: ResolvedSkillStandard[];
  sourcePriority: ['frontmatter', 'confirmed_soft', 'pending_soft'];
}

export interface ExtractSkillSoftStandardsOptions {
  observationsDir: string;
  skillChain: ObservationSkillChain;
  runtimeEvidence?: SkillLlmEnhancedRuntimeEvidence;
  model?: string;
  executorName?: string;
  refresh?: boolean;
  now?: string;
  executor?: ExecutorFn;
}

export interface ResolveSkillStandardsOptions {
  observationsDir: string;
  cwd?: string;
  skillChain?: ObservationSkillChain;
  derivedStandards?: SkillDerivedStandards | Record<string, SkillDerivedStandards>;
}

export function skillDerivedStandardsDir(observationsDir: string): string {
  return join(observationsDir, 'skill-derived');
}

export function skillDerivedStandardsPath(observationsDir: string, skillName: string): string {
  return join(skillDerivedStandardsDir(observationsDir), `${safeSkillFileName(skillName)}.json`);
}

export function loadSkillDerivedStandards(observationsDir: string): Record<string, SkillDerivedStandards> {
  const dir = skillDerivedStandardsDir(observationsDir);
  if (!existsSync(dir)) return {};
  const out: Record<string, SkillDerivedStandards> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SkillDerivedStandards;
      if (isSkillDerivedStandards(parsed)) out[parsed.skillName] = parsed;
    } catch {
      // Ignore broken cache files; the extraction command can refresh them.
    }
  }
  return out;
}

export function updateSkillDerivedStandardStatus(
  observationsDir: string,
  skillName: string,
  standardId: string,
  status: SkillDerivedStandardStatus,
  now = new Date().toISOString(),
): SkillDerivedStandards {
  const filePath = skillDerivedStandardsPath(observationsDir, skillName);
  const existing = loadExisting(filePath);
  if (!existing) throw new Error(`skill derived standards not found: ${skillName}`);
  let found = false;
  const next: SkillDerivedStandards = {
    ...existing,
    generatedAt: now,
    standards: existing.standards.map((item) => {
      if (item.id !== standardId) return item;
      found = true;
      return { ...item, status };
    }),
  };
  if (!found) throw new Error(`skill derived standard not found: ${standardId}`);
  mkdirSync(skillDerivedStandardsDir(observationsDir), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

export function resolveSkillStandards(skillName: string, options: ResolveSkillStandardsOptions): ResolvedSkillStandards {
  const skillChain = options.skillChain ?? buildObservationSkillChain(skillName, options.cwd ?? process.cwd());
  const derived = options.derivedStandards
    ? isSkillDerivedStandards(options.derivedStandards)
      ? options.derivedStandards
      : options.derivedStandards[skillName]
    : loadSkillDerivedStandards(options.observationsDir)[skillName];
  const active: ResolvedSkillStandard[] = [];
  const candidates: ResolvedSkillStandard[] = [];
  const hasFrontmatterHardRules = skillChain.healthCheck.hardRules.declared && skillChain.healthCheck.hardRules.rules.length > 0;
  const hasFrontmatterWorkflows = skillChain.healthCheck.workflows.declared && skillChain.healthCheck.workflows.workflows.length > 0;

  for (const rule of skillChain.healthCheck.hardRules.rules) {
    active.push({
      id: rule.id,
      kind: 'hard_rule',
      title: rule.rule,
      body: rule.expectedBehavior,
      source: 'frontmatter',
    });
  }
  for (const workflow of skillChain.healthCheck.workflows.workflows) {
    for (const node of workflow.nodes) {
      active.push({
        id: `${workflow.id}.${node.id}`,
        kind: 'workflow',
        title: `${workflow.id} / ${node.id}`,
        body: node.action,
        source: 'frontmatter',
      });
    }
  }

  for (const standard of derived?.standards ?? []) {
    const kind: ResolvedSkillStandardKind = standard.kind === 'workflow_candidate' ? 'workflow' : 'hard_rule';
    const blockedByFrontmatter = kind === 'hard_rule' ? hasFrontmatterHardRules : hasFrontmatterWorkflows;
    const resolved: ResolvedSkillStandard = {
      id: standard.id,
      kind,
      title: standard.title,
      body: standard.body,
      source: standard.status === 'author_confirmed' ? 'confirmed_soft' : 'pending_soft',
      status: standard.status,
      confidence: standard.confidence,
      evidence: standard.evidence,
    };
    if (!blockedByFrontmatter && standard.status === 'author_confirmed') {
      active.push(resolved);
    } else {
      candidates.push(resolved);
    }
  }

  candidates.sort((a, b) => candidateRank(a.status) - candidateRank(b.status) || a.title.localeCompare(b.title));
  return {
    skillName,
    active,
    candidates,
    sourcePriority: ['frontmatter', 'confirmed_soft', 'pending_soft'],
  };
}

export async function extractSkillSoftStandards(options: ExtractSkillSoftStandardsOptions): Promise<SkillDerivedStandards> {
  const { observationsDir, skillChain } = options;
  const model = options.model || DEFAULT_LLM_ENHANCED_REVIEW_MODEL;
  const executorName = options.executorName || 'claude';
  const generatedAt = options.now || new Date().toISOString();
  const path = skillDerivedStandardsPath(observationsDir, skillChain.skillName);
  const sourceHash = skillChain.definition.content ? hashText(skillChain.definition.content) : undefined;
  const runtimeEvidenceHash = options.runtimeEvidence ? hashText(JSON.stringify(options.runtimeEvidence)) : undefined;
  const existing = loadExisting(path);
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
    mkdirSync(skillDerivedStandardsDir(observationsDir), { recursive: true });
    writeFileSync(path, JSON.stringify(stale, null, 2));
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
    schemaVersion: 1,
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
  mkdirSync(skillDerivedStandardsDir(observationsDir), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2));
  return record;
}

function buildSoftStandardPrompt(
  skillChain: ObservationSkillChain,
  flags: { needsHardRules: boolean; needsWorkflows: boolean },
  runtimeEvidence?: SkillLlmEnhancedRuntimeEvidence,
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
  kind: SkillRuntimeEvidencePackNode['kind'];
  title: string;
  expectation: string;
  candidateEvidenceSnippets: string[];
}> {
  return (evidencePack?.nodeEvidence ?? []).slice(0, 40).map((node) => ({
    nodeId: node.nodeId,
    kind: node.kind,
    title: node.title.slice(0, 120),
    expectation: node.expectation.slice(0, 240),
    candidateEvidenceSnippets: node.candidateEvidenceSnippets.slice(0, 3).map((snippet) => snippet.slice(0, 180)),
  }));
}

function readPromptTemplate() {
  return readPromptDocument({
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
      hardrules: legacyStandards.map((item, index) => normalizeStandardSectionItem(item, index)).filter((item): item is Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'> => Boolean(item)),
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
    kind,
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

function normalizeRuntimeSignals(value: unknown): RuntimeSignal[] {
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

function normalizeSignalOpForType(type: RuntimeSignalType, op: RuntimeSignalOp | undefined, valueIsArray: boolean): RuntimeSignalOp | undefined {
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

function normalizeRuntimeTriggers(value: unknown): RuntimeTrigger[] {
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

function normalizeStandardSection(value: unknown): Array<Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizeStandardSectionItem(item, index)).filter((item): item is Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'> => Boolean(item));
}

function normalizeStandardSectionItem(value: unknown, index: number): Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'> | null {
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
        ? `规则层已复核 ${nodeResults.filter((node) => node.kind !== 'stage').length} 个流程/规则节点。`
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
    kind: 'stage',
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
    kind,
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

type RuntimeSignalGroupName = RuntimeSignalRef['signalGroup'];

interface RuntimeSignalMatch {
  signal: RuntimeSignal;
  group: RuntimeSignalGroupName;
  refs: SkillRuntimeEvidencePackRef[];
}

interface RuntimeEvaluationContext {
  nodeScopedRefs: SkillRuntimeEvidencePackRef[];
}

function resolveNodeScopedRefs(node: RuntimeStandardNode, evidencePack: SkillRuntimeEvidencePack): SkillRuntimeEvidencePackRef[] {
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

function evaluateRuntimeStandardNodes(nodes: RuntimeStandardNode[], evidencePack: SkillRuntimeEvidencePack): RuntimeNodeResult[] {
  const rawResults = nodes.map((node) => evaluateRuntimeStandardNode(node, evidencePack, {
    nodeScopedRefs: resolveNodeScopedRefs(node, evidencePack),
  }));
  const resultByNodeId = new Map(rawResults.map((result) => [result.nodeId, result]));
  return rawResults.map((result) => {
    const node = nodes.find((item) => item.nodeId === result.nodeId);
    if (!node || node.kind !== 'stage' || !node.childNodeIds || node.childNodeIds.length === 0) return result;
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
    kind: node.kind,
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

function normalizeToolNameValue(value: string): string {
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

function normalizeFuzzyText(value: string): string {
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

function refsInScope(
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
  const item = value as Partial<SkillDerivedStandard>;
  const kind = item.kind === 'workflow_candidate' ? 'workflow_candidate' : item.kind === 'hard_rule_candidate' ? 'hard_rule_candidate' : undefined;
  if (!kind || typeof item.title !== 'string' || typeof item.body !== 'string') return null;
  const stable = [kind, item.title, item.body].join('\u0000');
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `soft-${createHash('sha256').update(stable).digest('hex').slice(0, 12)}-${index}`,
    kind,
    title: item.title.slice(0, 160),
    body: item.body.slice(0, 600),
    confidence: item.confidence === 'high' || item.confidence === 'medium' || item.confidence === 'low' ? item.confidence : 'low',
    evidence: Array.isArray(item.evidence) ? item.evidence.filter((entry): entry is string => typeof entry === 'string').slice(0, 5) : [],
  };
}

function loadExisting(path: string): SkillDerivedStandards | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SkillDerivedStandards;
    return isSkillDerivedStandards(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function markStale(record: SkillDerivedStandards, generatedAt: string): SkillDerivedStandards {
  return {
    ...record,
    generatedAt,
    standards: record.standards.map((item) => item.status === 'author_confirmed' || item.status === 'pending_review'
      ? { ...item, status: 'stale' }
      : item),
  };
}

function isSkillDerivedStandards(value: unknown): value is SkillDerivedStandards {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SkillDerivedStandards>;
  return item.kind === 'observe-skill-derived-standards'
    && item.schemaVersion === 1
    && typeof item.skillName === 'string'
    && Array.isArray(item.standards);
}

function candidateRank(status?: SkillDerivedStandardStatus): number {
  if (status === 'pending_review') return 0;
  if (status === 'stale') return 1;
  if (status === 'rejected') return 2;
  if (status === 'author_confirmed') return 3;
  return 4;
}

function safeSkillFileName(skillName: string): string {
  const base = skillName.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return `${base.slice(0, 80)}-${hashText(skillName).slice(0, 8)}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const __softStandardsTestInternals = {
  normalizeRuntimeSignals,
  normalizeRuntimeTriggers,
  evaluateRuntimeStandardNodes,
  normalizeFuzzyText,
  normalizeSignalOpForType,
  refsInScope,
  normalizeToolNameValue,
};
