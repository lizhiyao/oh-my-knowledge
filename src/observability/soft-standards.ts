import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorFn } from '../types/index.js';
import { createExecutor } from '../executors/index.js';
import { readPromptDocument } from '../shared/llm-prompts/index.js';
import { buildObservationSkillChain, type ObservationSkillChain } from './skill-chain.js';

export const SOFT_STANDARD_PROMPT_ID = 'llm-enhanced-review';
export const SOFT_STANDARD_PROMPT_VERSION = '2026-05-19.v2';
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
}

export type LlmEnhancedSkillType = 'router' | 'delegation' | 'executor' | 'advisory' | 'unknown';
export type LlmEnhancedVerdict = 'passed' | 'failed' | 'unknown';
export type LlmEnhancedUserFeeling = 'positive' | 'neutral' | 'negative' | 'frustrated';

export interface SkillLlmEnhancedReviewSections {
  skillType?: LlmEnhancedSkillType;
  extractedStandards?: {
    hardrules: Array<Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'>>;
    workflows: Array<Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'>>;
    completionCriteria: Array<Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'>>;
    artifactCriteria: Array<Omit<SkillDerivedStandard, 'id' | 'kind' | 'status' | 'source'>>;
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
  const compatibleCache = existing
    && existing.promptId === SOFT_STANDARD_PROMPT_ID
    && existing.promptVersion === SOFT_STANDARD_PROMPT_VERSION
    && existing.promptHash === promptDocument.hash;
  if (compatibleCache && !options.refresh && existing.sourceHash === sourceHash && existing.runtimeEvidenceHash === runtimeEvidenceHash) return existing;
  if (compatibleCache && !options.refresh && existing.standards.some((item) => item.status === 'author_confirmed')) {
    const stale = markStale(existing, generatedAt);
    mkdirSync(skillDerivedStandardsDir(observationsDir), { recursive: true });
    writeFileSync(path, JSON.stringify(stale, null, 2));
    return stale;
  }

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
  const enhancedReview = withRequiredStandardOwnerSuggestions(parseLlmEnhancedReviewOutput(result.output || ''), { needsHardRules, needsWorkflows });
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
  return JSON.stringify({
    task: 'llm_enhanced_review',
    promptId: SOFT_STANDARD_PROMPT_ID,
    promptVersion: SOFT_STANDARD_PROMPT_VERSION,
    skillName: skillChain.skillName,
    needsHardRules: flags.needsHardRules,
    needsWorkflows: flags.needsWorkflows,
    skillContent: skillChain.definition.content ?? '',
    runtimeSummary: skillChain.runtime.summary,
    runtimeEvidence: runtimeEvidence ?? {
      goalSlices: [],
      userMessages: [],
      assistantMessages: [],
      artifactCandidates: [],
      toolCalls: [],
      findings: [],
    },
  }, null, 2);
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
    userExperienceSignals: normalizeUserExperienceSignals(parsed?.userExperienceSignals),
    reviewerSummary: typeof parsed?.reviewerSummary === 'string' ? parsed.reviewerSummary.slice(0, 1200) : undefined,
    ownerSuggestions: normalizeOwnerSuggestions(parsed?.ownerSuggestions),
  };
}

function withRequiredStandardOwnerSuggestions(
  review: SkillLlmEnhancedReviewSections,
  flags: { needsHardRules: boolean; needsWorkflows: boolean },
): SkillLlmEnhancedReviewSections {
  const ownerSuggestions = [...(review.ownerSuggestions ?? [])];
  const hasSuggestion = (pattern: RegExp): boolean =>
    ownerSuggestions.some((item) => pattern.test([item.title, item.body, item.acceptanceCriteria].filter(Boolean).join('\n')));
  if (flags.needsHardRules && !hasSuggestion(/hard\s*rules?|hardRule|硬性规则|硬规则|规则声明/i)) {
    ownerSuggestions.push({
      title: '补充标准化硬性规则声明',
      body: '在 SKILL.md 中把必须执行、禁止执行、失败时必须停止或回退的约束写成可复盘的 hardRules。这样报告能区分“能力没有规则”与“规则已声明但运行未遵守”。',
      evidence: ['needsHardRules=true'],
      acceptanceCriteria: '下次评测中，定义链路能识别到 hardRules，报告不再提示缺少标准化硬性规则声明。',
    });
  }
  if (flags.needsWorkflows && !hasSuggestion(/workflow|工作流|流程|完成标准|产物标准|completion|artifact/i)) {
    ownerSuggestions.push({
      title: '补充标准化流程和完成标准',
      body: '在 SKILL.md 中声明标准 workflow、完成标准和产物标准，把前置检查、核心执行、失败阻断、最终交付写成可观测步骤。这样 LLM 增强复盘能按声明流程判断是否跑完整。',
      evidence: ['needsWorkflows=true'],
      acceptanceCriteria: '下次评测中，定义链路能识别到 workflow / completionCriteria / artifactCriteria，运行报告能按步骤展示执行情况。',
    });
  }
  return {
    ...review,
    ownerSuggestions: ownerSuggestions
      .filter((item) => item.title || item.body || item.acceptanceCriteria)
      .filter((item, index, arr) => {
        const key = [item.title, item.body, item.acceptanceCriteria].filter(Boolean).join('\u0000');
        return arr.findIndex((candidate) => [candidate.title, candidate.body, candidate.acceptanceCriteria].filter(Boolean).join('\u0000') === key) === index;
      })
      .slice(0, 10),
  };
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
  return value === 'router' || value === 'delegation' || value === 'executor' || value === 'advisory' || value === 'unknown'
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
  };
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
