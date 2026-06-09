import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildObservationSkillChain } from '../skill-chain.js';
import type {
  ResolveSkillStandardsOptions,
  ResolvedSkillStandard,
  ResolvedSkillStandardKind,
  ResolvedSkillStandards,
  SkillDerivedStandard,
  SkillDerivedStandardStatus,
  SkillDerivedStandards,
} from './types.js';

export const SKILL_DERIVED_STANDARDS_SCHEMA_VERSION = 2;

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
      const parsed = normalizeSkillDerivedStandards(JSON.parse(readFileSync(join(dir, file), 'utf-8')));
      if (parsed) out[parsed.skillName] = parsed;
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
  const directDerived = normalizeSkillDerivedStandards(options.derivedStandards);
  const mappedDerived = options.derivedStandards && !isSkillDerivedStandards(options.derivedStandards)
    ? normalizeSkillDerivedStandards(options.derivedStandards[skillName])
    : undefined;
  const derived = directDerived
    ?? mappedDerived
    ?? loadSkillDerivedStandards(options.observationsDir)[skillName];
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
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const kind = item.kind === 'observe-skill-derived-standards' ? item.kind : null;
  if (!kind) return undefined;
  if (item.schemaVersion !== 1 && item.schemaVersion !== 2) return undefined;
  if (typeof item.skillName !== 'string' || typeof item.generatedAt !== 'string' || typeof item.model !== 'string' || typeof item.executor !== 'string') {
    return undefined;
  }
  if (typeof item.promptId !== 'string' || typeof item.promptVersion !== 'string' || !Array.isArray(item.standards)) return undefined;
  const standards = item.standards
    .map(normalizeSkillDerivedStandard)
    .filter((record): record is SkillDerivedStandard => record !== null);
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
    ...(item.enhancedReview && typeof item.enhancedReview === 'object' ? { enhancedReview: item.enhancedReview as SkillDerivedStandards['enhancedReview'] } : {}),
    standards,
  };
}

function normalizeSkillDerivedStandard(value: unknown): SkillDerivedStandard | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const standardKind = item.standardKind === 'hard_rule_candidate' || item.standardKind === 'workflow_candidate'
    ? item.standardKind
    : item.kind === 'hard_rule_candidate' || item.kind === 'workflow_candidate'
      ? item.kind
      : null;
  if (!standardKind) return null;
  if (typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.body !== 'string') return null;
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
