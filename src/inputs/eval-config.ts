import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { parseYaml } from './load-samples.js';
import type {
  EvalConfig,
  EvalConfigVariant,
  ExperimentRole,
  VariantSpec,
} from '../types.js';

const VALID_ROLES: readonly ExperimentRole[] = ['control', 'treatment'];

/**
 * Load and validate an eval.yaml (or .json) config file.
 * All relative paths in the config are resolved against the config file's directory.
 */
export function loadEvalConfig(configPath: string): EvalConfig {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    throw new Error(`--config 指定的文件不存在: ${absPath}`);
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
    throw new Error(`${configPath}: 顶层必须是对象`);
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.samples !== 'string' || !obj.samples) {
    throw new Error(`${configPath}: samples 字段必填，需为字符串`);
  }
  if (!Array.isArray(obj.variants) || obj.variants.length === 0) {
    throw new Error(`${configPath}: variants 字段必填，需为非空数组`);
  }

  const variants: EvalConfigVariant[] = [];
  const seen = new Set<string>();
  let hasAnyRole = false;

  for (const [i, raw] of (obj.variants as unknown[]).entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${configPath}: variants[${i}] 必须是对象`);
    }
    const v = raw as Record<string, unknown>;
    if (typeof v.name !== 'string' || !v.name) {
      throw new Error(`${configPath}: variants[${i}].name 必填，需为字符串`);
    }
    if (typeof v.role !== 'string' || !VALID_ROLES.includes(v.role as ExperimentRole)) {
      throw new Error(
        `${configPath}: variants[${i}].role 必须是 'control' 或 'treatment'（当前：${JSON.stringify(v.role)}）`,
      );
    }
    if (typeof v.artifact !== 'string' || !v.artifact) {
      throw new Error(`${configPath}: variants[${i}].artifact 必填，需为字符串`);
    }
    if (v.cwd !== undefined && typeof v.cwd !== 'string') {
      throw new Error(`${configPath}: variants[${i}].cwd 必须是字符串`);
    }
    if (seen.has(v.name)) {
      throw new Error(`${configPath}: variants[${i}].name "${v.name}" 重复`);
    }
    seen.add(v.name);
    hasAnyRole = true;
    variants.push({
      name: v.name,
      role: v.role as ExperimentRole,
      artifact: v.artifact,
      cwd: v.cwd as string | undefined,
    });
  }

  if (!hasAnyRole) {
    throw new Error(`${configPath}: variants 里至少要有一个 control 或 treatment`);
  }

  const assertStringOpt = (key: string): void => {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') {
      throw new Error(`${configPath}: ${key} 必须是字符串`);
    }
  };
  const assertNumberOpt = (key: string): void => {
    if (obj[key] !== undefined && typeof obj[key] !== 'number') {
      throw new Error(`${configPath}: ${key} 必须是数字`);
    }
  };
  const assertBoolOpt = (key: string): void => {
    if (obj[key] !== undefined && typeof obj[key] !== 'boolean') {
      throw new Error(`${configPath}: ${key} 必须是布尔值`);
    }
  };

  assertStringOpt('executor');
  assertStringOpt('model');
  if (obj.judgeModel !== undefined && obj.judgeModel !== null && typeof obj.judgeModel !== 'string') {
    throw new Error(`${configPath}: judgeModel 必须是字符串或 null`);
  }
  if (obj.judgeExecutor !== undefined && obj.judgeExecutor !== null && typeof obj.judgeExecutor !== 'string') {
    throw new Error(`${configPath}: judgeExecutor 必须是字符串或 null`);
  }
  assertNumberOpt('concurrency');
  assertNumberOpt('timeoutMs');
  assertBoolOpt('noCache');
  assertBoolOpt('blind');
  assertStringOpt('mcpConfig');

  // v0.22 — budget validation. Top-level `budget: { totalUSD?, perSampleUSD?, perSampleMs? }`.
  let budget: import('../types.js').EvalBudget | undefined;
  if (obj.budget !== undefined) {
    if (typeof obj.budget !== 'object' || obj.budget === null || Array.isArray(obj.budget)) {
      throw new Error(`${configPath}: budget 必须是对象`);
    }
    const b = obj.budget as Record<string, unknown>;
    for (const k of ['totalUSD', 'perSampleUSD', 'perSampleMs']) {
      if (b[k] !== undefined && (typeof b[k] !== 'number' || b[k] as number < 0)) {
        throw new Error(`${configPath}: budget.${k} 必须是非负数字`);
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
