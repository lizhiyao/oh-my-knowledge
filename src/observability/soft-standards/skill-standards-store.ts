import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildObservationSkillChain } from '../skill-chain.js';
import type {
  ResolveSkillStandardsOptions,
  ResolvedSkillStandard,
  ResolvedSkillStandardKind,
  ResolvedSkillStandards,
  SkillDerivedStandardStatus,
  SkillDerivedStandards,
} from './types.js';

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

export function loadExisting(path: string): SkillDerivedStandards | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SkillDerivedStandards;
    return isSkillDerivedStandards(parsed) ? parsed : undefined;
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

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
