import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorFn } from '../types/index.js';
import { createExecutor } from '../executors/index.js';
import { buildObservationSkillChain, type ObservationSkillChain } from './skill-chain.js';

export const SOFT_STANDARD_PROMPT_ID = 'soft-standard-extract';
export const SOFT_STANDARD_PROMPT_VERSION = '2026-05-14.v1';
export const DEFAULT_SOFT_STANDARD_MODEL = 'sonnet';

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
  standards: SkillDerivedStandard[];
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
  const model = options.model || DEFAULT_SOFT_STANDARD_MODEL;
  const executorName = options.executorName || 'claude';
  const generatedAt = options.now || new Date().toISOString();
  const path = skillDerivedStandardsPath(observationsDir, skillChain.skillName);
  const sourceHash = skillChain.definition.content ? hashText(skillChain.definition.content) : undefined;
  const existing = loadExisting(path);
  if (existing && !options.refresh && existing.sourceHash === sourceHash) return existing;
  if (existing && !options.refresh && existing.standards.some((item) => item.status === 'author_confirmed')) {
    const stale = markStale(existing, generatedAt);
    mkdirSync(skillDerivedStandardsDir(observationsDir), { recursive: true });
    writeFileSync(path, JSON.stringify(stale, null, 2));
    return stale;
  }

  const needsHardRules = !skillChain.healthCheck.hardRules.declared;
  const needsWorkflows = !skillChain.healthCheck.workflows.declared;
  const prompt = buildSoftStandardPrompt(skillChain, { needsHardRules, needsWorkflows });
  const executor = options.executor ?? createExecutor(executorName);
  const result = await executor({
    model,
    system: readPromptTemplate(),
    prompt,
    timeoutMs: 300_000,
    lean: true,
  });
  const standards = parseSoftStandardOutput(result.output || '').map((item) => ({
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
    standards,
  };
  mkdirSync(skillDerivedStandardsDir(observationsDir), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2));
  return record;
}

function buildSoftStandardPrompt(skillChain: ObservationSkillChain, flags: { needsHardRules: boolean; needsWorkflows: boolean }): string {
  return JSON.stringify({
    task: 'extract_soft_standards',
    promptId: SOFT_STANDARD_PROMPT_ID,
    promptVersion: SOFT_STANDARD_PROMPT_VERSION,
    skillName: skillChain.skillName,
    needsHardRules: flags.needsHardRules,
    needsWorkflows: flags.needsWorkflows,
    skillContent: skillChain.definition.content ?? '',
    runtimeSummary: skillChain.runtime.summary,
  }, null, 2);
}

function readPromptTemplate(): string {
  const path = join(process.cwd(), 'docs', 'prompts', 'soft-standard-extract.prompt.md');
  if (!existsSync(path)) throw new Error(`missing prompt document: ${path}`);
  return readFileSync(path, 'utf-8');
}

function parseSoftStandardOutput(output: string): Array<Omit<SkillDerivedStandard, 'status' | 'source'>> {
  const parsed = parseJsonObject(output);
  const raw = Array.isArray(parsed?.standards) ? parsed.standards : [];
  return raw.map((item, index) => normalizeStandard(item, index)).filter((item): item is Omit<SkillDerivedStandard, 'status' | 'source'> => Boolean(item));
}

function parseJsonObject(output: string): { standards?: unknown[] } | null {
  try {
    return JSON.parse(output) as { standards?: unknown[] };
  } catch {
    const match = output.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as { standards?: unknown[] };
    } catch {
      return null;
    }
  }
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
