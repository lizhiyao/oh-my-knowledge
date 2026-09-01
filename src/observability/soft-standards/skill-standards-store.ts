import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildObservationSkillChain } from '../skill-health/skill-chain.js';
import {
  ownRecordValue,
  setOwnRecordValue,
} from '../../shared/record-count.js';
import {
  loadObservationReviewState,
  observationReviewStateKey,
  type ObservationReviewState,
} from '../inbox/review-state.js';
import type {
  ResolveSkillStandardsOptions,
  ResolvedSkillStandard,
  ResolvedSkillStandardKind,
  ResolvedSkillStandards,
  SkillDerivedStandard,
  SkillDerivedStandardStatus,
  SkillDerivedStandards,
} from './types.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { isRfc3339Timestamp } from '../../shared/timestamp.js';

export const SKILL_DERIVED_STANDARDS_SCHEMA_VERSION = 2;

export function skillDerivedStandardsDir(observationsDir: string): string {
  return join(observationsDir, 'skill-derived');
}

export function skillDerivedStandardsPath(observationsDir: string, skillName: string): string {
  return join(skillDerivedStandardsDir(observationsDir), `${safeSkillFileName(skillName)}.json`);
}

export function loadSkillDerivedStandards(
  observationsDir: string,
  reviewState: ObservationReviewState = loadObservationReviewState(observationsDir),
): Record<string, SkillDerivedStandards> {
  const dir = skillDerivedStandardsDir(observationsDir);
  if (!existsSync(dir)) return {};
  const out: Record<string, SkillDerivedStandards> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = normalizeSkillDerivedStandards(JSON.parse(readFileSync(join(dir, file), 'utf-8')));
      if (parsed) {
        setOwnRecordValue(out, parsed.skillName, applySoftStandardReviews(parsed, reviewState));
      }
    } catch {
      // Ignore broken cache files; the extraction command can refresh them.
    }
  }
  return out;
}

function applySoftStandardReviews(
  record: SkillDerivedStandards,
  reviewState: ObservationReviewState,
): SkillDerivedStandards {
  const generatedAt = Date.parse(record.generatedAt);
  return {
    ...record,
    standards: record.standards.map((standard) => {
      if (standard.status === 'stale') return standard;
      const targetId = `${record.skillName}:${standard.id}`;
      const entry = reviewState.entries[observationReviewStateKey('soft_standard', targetId)];
      if (!entry || Date.parse(entry.reviewedAt) < generatedAt) return standard;
      if (entry.verdict === 'real_issue') return { ...standard, status: 'author_confirmed' };
      if (entry.verdict === 'not_issue') return { ...standard, status: 'rejected' };
      if (entry.verdict === 'needs_more_context' || entry.verdict === 'reviewed') {
        return { ...standard, status: 'pending_review' };
      }
      return standard;
    }),
  };
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
  writeJsonFileAtomic(filePath, next);
  return next;
}

export function resolveSkillStandards(skillName: string, options: ResolveSkillStandardsOptions): ResolvedSkillStandards {
  const skillChain = options.skillChain ?? buildObservationSkillChain(skillName, options.cwd ?? process.cwd());
  const directDerived = normalizeSkillDerivedStandards(options.derivedStandards);
  const mappedDerived = options.derivedStandards && !isSkillDerivedStandards(options.derivedStandards)
    ? normalizeSkillDerivedStandards(ownRecordValue(options.derivedStandards, skillName))
    : undefined;
  const derived = directDerived
    ?? mappedDerived
    ?? ownRecordValue(loadSkillDerivedStandards(options.observationsDir), skillName);
  const active: ResolvedSkillStandard[] = [];
  const candidates: ResolvedSkillStandard[] = [];
  const hasFrontmatterHardRules = skillChain.healthCheck.hardRules.declared && skillChain.healthCheck.hardRules.rules.length > 0;
  const hasFrontmatterWorkflows = skillChain.healthCheck.workflows.declared && skillChain.healthCheck.workflows.workflows.length > 0;

  for (const rule of skillChain.healthCheck.hardRules.rules) {
    active.push({
      id: rule.id,
      standardKind: 'hard_rule',
      title: rule.rule,
      body: rule.expectedBehavior,
      source: 'frontmatter',
    });
  }
  for (const workflow of skillChain.healthCheck.workflows.workflows) {
    for (const node of workflow.nodes) {
      active.push({
        id: `${workflow.id}.${node.id}`,
        standardKind: 'workflow',
        title: `${workflow.id} / ${node.id}`,
        body: node.action,
        source: 'frontmatter',
      });
    }
  }

  for (const standard of derived?.standards ?? []) {
    const kind: ResolvedSkillStandardKind = standard.standardKind === 'workflow_candidate' ? 'workflow' : 'hard_rule';
    const blockedByFrontmatter = kind === 'hard_rule' ? hasFrontmatterHardRules : hasFrontmatterWorkflows;
    const resolved: ResolvedSkillStandard = {
      id: standard.id,
      standardKind: kind,
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

export function loadExisting(path: string): SkillDerivedStandards | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return normalizeSkillDerivedStandards(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return undefined;
  }
}

export function markStale(record: SkillDerivedStandards, generatedAt: string): SkillDerivedStandards {
  return {
    ...record,
    generatedAt,
    standards: record.standards.map((item) => item.status === 'author_confirmed' || item.status === 'pending_review'
      ? { ...item, status: 'stale' }
      : item),
  };
}

export function isSkillDerivedStandards(value: unknown): value is SkillDerivedStandards {
  return normalizeSkillDerivedStandards(value) !== undefined;
}

function normalizeSkillDerivedStandards(value: unknown): SkillDerivedStandards | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const kind = item.kind === 'observe-skill-derived-standards' ? item.kind : null;
  if (!kind) return undefined;
  if (item.schemaVersion !== SKILL_DERIVED_STANDARDS_SCHEMA_VERSION) return undefined;
  if (
    !isNonEmptyString(item.skillName)
    || !isTimestamp(item.generatedAt)
    || !isNonEmptyString(item.model)
    || !isNonEmptyString(item.executor)
  ) {
    return undefined;
  }
  if (!isNonEmptyString(item.promptId) || !isNonEmptyString(item.promptVersion) || !Array.isArray(item.standards)) return undefined;
  const standards = item.standards.map(normalizeSkillDerivedStandard);
  if (standards.some((record) => record === null)) return undefined;
  const validStandards = standards as SkillDerivedStandard[];
  if (new Set(validStandards.map((record) => record.id)).size !== validStandards.length) return undefined;
  if (item.enhancedReview !== undefined && (!item.enhancedReview || typeof item.enhancedReview !== 'object' || Array.isArray(item.enhancedReview))) {
    return undefined;
  }
  return {
    kind: 'observe-skill-derived-standards',
    schemaVersion: SKILL_DERIVED_STANDARDS_SCHEMA_VERSION,
    skillName: item.skillName,
    ...(typeof item.sourceSkillPath === 'string' ? { sourceSkillPath: item.sourceSkillPath } : {}),
    ...(typeof item.sourceHash === 'string' ? { sourceHash: item.sourceHash } : {}),
    generatedAt: item.generatedAt,
    model: item.model,
    executor: item.executor,
    promptId: item.promptId as SkillDerivedStandards['promptId'],
    promptVersion: item.promptVersion as SkillDerivedStandards['promptVersion'],
    ...(typeof item.promptHash === 'string' ? { promptHash: item.promptHash } : {}),
    ...(typeof item.runtimeEvidenceHash === 'string' ? { runtimeEvidenceHash: item.runtimeEvidenceHash } : {}),
    ...(item.enhancedReview ? { enhancedReview: item.enhancedReview as SkillDerivedStandards['enhancedReview'] } : {}),
    standards: validStandards,
  };
}

function normalizeSkillDerivedStandard(value: unknown): SkillDerivedStandard | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const standardKind = item.standardKind === 'hard_rule_candidate' || item.standardKind === 'workflow_candidate'
    ? item.standardKind
    : item.kind === 'hard_rule_candidate' || item.kind === 'workflow_candidate'
      ? item.kind
      : null;
  if (!standardKind) return null;
  if (!isNonEmptyString(item.id) || !isNonEmptyString(item.title) || typeof item.body !== 'string') return null;
  if (item.status !== 'pending_review' && item.status !== 'author_confirmed' && item.status !== 'rejected' && item.status !== 'stale') {
    return null;
  }
  if (item.source !== 'llm_soft_standard') return null;
  if (item.confidence !== 'low' && item.confidence !== 'medium' && item.confidence !== 'high') return null;
  if (!Array.isArray(item.evidence) || item.evidence.some((entry) => typeof entry !== 'string')) return null;
  return {
    id: item.id,
    standardKind,
    status: item.status,
    title: item.title,
    body: item.body,
    source: item.source,
    confidence: item.confidence,
    evidence: item.evidence,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isRfc3339Timestamp(value);
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

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
