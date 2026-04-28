import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { parseYaml } from './load-samples.js';
import type {
  EvalConfig,
  EvalConfigVariant,
  ExperimentRole,
  VariantSpec,
} from '../types/index.js';

const VALID_ROLES: readonly ExperimentRole[] = ['control', 'treatment'];

/**
 * Load and validate an eval.yaml (or .json) config file.
 * All relative paths in the config are resolved against the config file's directory.
 */
export function loadEvalConfig(configPath: string): EvalConfig {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    throw new Error(`--config file does not exist: ${absPath}`);
  }
  const raw = readFileSync(absPath, 'utf-8');
  const isJson = absPath.endsWith('.json');
  const parsed: unknown = isJson ? JSON.parse(raw) : parseYaml(raw);
  const config = validateEvalConfig(parsed, configPath);
  return resolveConfigPaths(config, dirname(absPath));
}

/**
 * Convert EvalConfig.variants into VariantSpec[] (the CLI-internal representation).
 * A variant's `cwd` (if present) is merged into the expression as `artifact@cwd`
 * so the downstream variant resolver can treat CLI and config uniformly.
 */
export function configVariantsToSpecs(variants: EvalConfigVariant[]): VariantSpec[] {
  return variants.map((v) => ({
    name: v.name,
    role: v.role,
    expr: v.cwd ? `${v.artifact}@${v.cwd}` : v.artifact,
  }));
}

function validateEvalConfig(parsed: unknown, configPath: string): EvalConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath}: top level must be an object`);
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.samples !== 'string' || !obj.samples) {
    throw new Error(`${configPath}: 'samples' is required and must be a string`);
  }
  if (!Array.isArray(obj.variants) || obj.variants.length === 0) {
    throw new Error(`${configPath}: 'variants' is required and must be a non-empty array`);
  }

  const variants: EvalConfigVariant[] = [];
  const seen = new Set<string>();
  let hasAnyRole = false;

  for (const [i, raw] of (obj.variants as unknown[]).entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${configPath}: variants[${i}] must be an object`);
    }
    const v = raw as Record<string, unknown>;
    if (typeof v.name !== 'string' || !v.name) {
      throw new Error(`${configPath}: variants[${i}].name is required and must be a string`);
    }
    if (typeof v.role !== 'string' || !VALID_ROLES.includes(v.role as ExperimentRole)) {
      throw new Error(
        `${configPath}: variants[${i}].role must be 'control' or 'treatment' (got: ${JSON.stringify(v.role)})`,
      );
    }
    if (typeof v.artifact !== 'string' || !v.artifact) {
      throw new Error(`${configPath}: variants[${i}].artifact is required and must be a string`);
    }
    if (v.cwd !== undefined && typeof v.cwd !== 'string') {
      throw new Error(`${configPath}: variants[${i}].cwd must be a string`);
    }
    // v0.22 — allowedSkills schema check. YAML key without value parses as null,
    // which is ambiguous ("none" vs "default"); reject so users must write `[]`
    // explicitly. undefined (key absent) means "use --strict-baseline default".
    let allowedSkills: string[] | undefined;
    if (v.allowedSkills !== undefined) {
      if (v.allowedSkills === null) {
        throw new Error(
          `${configPath}: variants[${i}].allowedSkills must be an array (use [] to disable skill discovery, or omit the key for default behavior). YAML \`allowedSkills:\` without a value parses as null, which is ambiguous.`,
        );
      }
      if (!Array.isArray(v.allowedSkills)) {
        throw new Error(`${configPath}: variants[${i}].allowedSkills must be an array of strings`);
      }
      for (const [j, name] of (v.allowedSkills as unknown[]).entries()) {
        if (typeof name !== 'string' || !name) {
          throw new Error(`${configPath}: variants[${i}].allowedSkills[${j}] must be a non-empty string`);
        }
      }
      allowedSkills = v.allowedSkills as string[];
    }
    if (seen.has(v.name)) {
      throw new Error(`${configPath}: variants[${i}].name "${v.name}" is duplicated`);
    }
    seen.add(v.name);
    hasAnyRole = true;
    variants.push({
      name: v.name,
      role: v.role as ExperimentRole,
      artifact: v.artifact,
      cwd: v.cwd as string | undefined,
      ...(allowedSkills !== undefined && { allowedSkills }),
    });
  }

  if (!hasAnyRole) {
    throw new Error(`${configPath}: variants must contain at least one control or treatment entry`);
  }

  const assertStringOpt = (key: string): void => {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') {
      throw new Error(`${configPath}: ${key} must be a string`);
    }
  };
  const assertNumberOpt = (key: string): void => {
    if (obj[key] !== undefined && typeof obj[key] !== 'number') {
      throw new Error(`${configPath}: ${key} must be a number`);
    }
  };
  const assertBoolOpt = (key: string): void => {
    if (obj[key] !== undefined && typeof obj[key] !== 'boolean') {
      throw new Error(`${configPath}: ${key} must be a boolean`);
    }
  };

  assertStringOpt('executor');
  assertStringOpt('model');
  if (obj.judgeModel !== undefined && obj.judgeModel !== null && typeof obj.judgeModel !== 'string') {
    throw new Error(`${configPath}: judgeModel must be a string or null`);
  }
  if (obj.judgeExecutor !== undefined && obj.judgeExecutor !== null && typeof obj.judgeExecutor !== 'string') {
    throw new Error(`${configPath}: judgeExecutor must be a string or null`);
  }
  assertNumberOpt('concurrency');
  assertNumberOpt('timeoutMs');
  assertBoolOpt('noCache');
  assertBoolOpt('blind');
  assertStringOpt('mcpConfig');

  // v0.22 — budget validation. Top-level `budget: { totalUSD?, perSampleUSD?, perSampleMs? }`.
  let budget: import('../types/index.js').EvalBudget | undefined;
  if (obj.budget !== undefined) {
    if (typeof obj.budget !== 'object' || obj.budget === null || Array.isArray(obj.budget)) {
      throw new Error(`${configPath}: budget must be an object`);
    }
    const b = obj.budget as Record<string, unknown>;
    for (const k of ['totalUSD', 'perSampleUSD', 'perSampleMs']) {
      if (b[k] !== undefined && (typeof b[k] !== 'number' || b[k] as number < 0)) {
        throw new Error(`${configPath}: budget.${k} must be a non-negative number`);
      }
    }
    budget = {
      totalUSD: b.totalUSD as number | undefined,
      perSampleUSD: b.perSampleUSD as number | undefined,
      perSampleMs: b.perSampleMs as number | undefined,
    };
  }

  return {
    samples: obj.samples as string,
    executor: obj.executor as string | undefined,
    model: obj.model as string | undefined,
    judgeModel: obj.judgeModel as string | null | undefined,
    judgeExecutor: obj.judgeExecutor as string | null | undefined,
    concurrency: obj.concurrency as number | undefined,
    timeoutMs: obj.timeoutMs as number | undefined,
    noCache: obj.noCache as boolean | undefined,
    blind: obj.blind as boolean | undefined,
    mcpConfig: obj.mcpConfig as string | undefined,
    variants,
    budget,
  };
}

function resolveConfigPaths(config: EvalConfig, configDir: string): EvalConfig {
  const resolveRel = (p: string): string => (isAbsolute(p) ? p : join(configDir, p));
  // Artifact expressions that are not file paths (baseline / git: / plain names) stay as-is.
  const looksLikePath = (expr: string): boolean =>
    expr.startsWith('./') || expr.startsWith('../') || expr.startsWith('/') || /\.(md|yaml|yml|json)$/i.test(expr);
  const isNonPathExpr = (expr: string): boolean =>
    expr === 'baseline' || expr.startsWith('git:');

  return {
    ...config,
    samples: resolveRel(config.samples),
    mcpConfig: config.mcpConfig ? resolveRel(config.mcpConfig) : undefined,
    variants: config.variants.map((v) => ({
      ...v,
      artifact: isNonPathExpr(v.artifact) ? v.artifact : (looksLikePath(v.artifact) ? resolveRel(v.artifact) : v.artifact),
      cwd: v.cwd ? resolveRel(v.cwd) : undefined,
    })),
  };
}
