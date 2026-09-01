import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { parseYaml } from './load-samples.js';
import type { EvalBudget, EvalConfig, EvalConfigVariant } from './contracts/config.js';
import type { ExperimentRole } from '../artifacts/contracts.js';
import type { RemoteGitRef, VariantSpec } from './contracts/variant.js';

const VALID_ROLES: readonly ExperimentRole[] = ['control', 'treatment'];

/**
 * Machine-enumerable public input surface accepted by the current eval config
 * validator. Nested object containers are included because they are user-facing
 * source keys too; #451's registry guard requires every path to be classified.
 */
export const EVAL_CONFIG_SCHEMA_SOURCE_PATHS = [
  'samples',
  'executor',
  'model',
  'effort',
  'noDiagnostic',
  'skipDoctor',
  'judgeModels',
  'judgeModels[].executor',
  'judgeModels[].model',
  'concurrency',
  'timeoutMs',
  'noCache',
  'noJudge',
  'mcpConfig',
  'variants',
  'variants[].name',
  'variants[].role',
  'variants[].artifact',
  'variants[].git',
  'variants[].git.url',
  'variants[].git.ref',
  'variants[].git.spec',
  'variants[].cwd',
  'variants[].allowedSkills',
  'budget',
  'budget.totalUSD',
  'budget.perSampleUSD',
  'budget.perSampleMs',
  'repeat',
  'holdoutRatio',
  'judgeRepeat',
  'bootstrap',
  'bootstrapSamples',
  'goldDir',
  'lengthDebias',
  'strictBaseline',
] as const;

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
  return variants.map((v) => {
    // 远端 git:expr 落规范身份串 `git+<url>@<ref>:<spec>`(仅供 variantIdentity 去重、绝不 re-split),
    // 真正解析走结构化 spec.git;本地 artifact 直接用其字符串身份。
    const expr = v.git ? `git+${v.git.url}@${v.git.ref ?? 'HEAD'}:${v.git.spec}` : (v.artifact as string);
    return {
      name: v.name,
      role: v.role,
      expr,
      ...(v.git !== undefined && { git: v.git }),
      ...(v.cwd !== undefined && { cwd: v.cwd }),
      ...(v.allowedSkills !== undefined && { allowedSkills: v.allowedSkills }),
    };
  });
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
    // artifact(本地字符串身份)与 git(远端结构化)二选一、不可兼有。
    const hasArtifact = v.artifact !== undefined;
    const hasGit = v.git !== undefined;
    if (hasArtifact === hasGit) {
      throw new Error(`${configPath}: variants[${i}] must have exactly one of 'artifact' or 'git'`);
    }
    if (hasArtifact && (typeof v.artifact !== 'string' || !v.artifact)) {
      throw new Error(`${configPath}: variants[${i}].artifact must be a non-empty string`);
    }
    let git: RemoteGitRef | undefined;
    if (hasGit) {
      if (typeof v.git !== 'object' || v.git === null || Array.isArray(v.git)) {
        throw new Error(`${configPath}: variants[${i}].git must be an object { url, ref?, spec }`);
      }
      const g = v.git as Record<string, unknown>;
      if (typeof g.url !== 'string' || !g.url) {
        throw new Error(`${configPath}: variants[${i}].git.url is required and must be a string`);
      }
      if (typeof g.spec !== 'string' || !g.spec) {
        throw new Error(`${configPath}: variants[${i}].git.spec is required and must be a string (in-repo skill path)`);
      }
      if (g.ref !== undefined && (typeof g.ref !== 'string' || !g.ref)) {
        throw new Error(`${configPath}: variants[${i}].git.ref must be a non-empty string when present`);
      }
      git = { url: g.url, spec: g.spec, ...(g.ref !== undefined && { ref: g.ref as string }) };
    }
    if (v.cwd !== undefined && typeof v.cwd !== 'string') {
      throw new Error(`${configPath}: variants[${i}].cwd must be a string`);
    }
    //  — allowedSkills schema check. YAML key without value parses as null,
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
      if ((v.allowedSkills as string[]).length > 0) {
        throw new Error(
          `${configPath}: variants[${i}].allowedSkills must be [] (strict isolation: no skills) or omitted (no isolation) — a non-empty skill whitelist is no longer supported because it could not be fully isolated (the subagent Skill tool and cwd filesystem channels leaked). For a multi-skill experiment, control the eval environment instead.`,
        );
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
      ...(hasArtifact && { artifact: v.artifact as string }),
      ...(git !== undefined && { git }),
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
  const assertBoolOpt = (key: string): void => {
    if (obj[key] !== undefined && typeof obj[key] !== 'boolean') {
      throw new Error(`${configPath}: ${key} must be a boolean`);
    }
  };

  assertStringOpt('executor');
  assertStringOpt('model');
  if (obj.judgeModel !== undefined || obj.judgeExecutor !== undefined) {
    throw new Error(
      `${configPath}: \`judgeModel\` and \`judgeExecutor\` were removed in v0.25 — use \`judgeModels: [{executor, model}]\` instead (single judge is the 1-entry case). See README.`,
    );
  }
  if (obj.blind !== undefined) {
    throw new Error(
      `${configPath}: \`blind\` (judge blind mode) was removed — delete it from your eval.yaml; reports are no longer blinded.`,
    );
  }
  assertBoolOpt('noCache');
  assertBoolOpt('noJudge');
  assertStringOpt('mcpConfig');
  assertStringOpt('goldDir');
  assertBoolOpt('bootstrap');
  assertBoolOpt('lengthDebias');
  assertBoolOpt('strictBaseline');

  // experiment-design integers ≥ 1
  const assertPositiveIntOpt = (key: string): void => {
    if (obj[key] === undefined) return;
    if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key]) || (obj[key] as number) < 1 || !Number.isInteger(obj[key])) {
      throw new Error(`${configPath}: ${key} must be a positive integer (≥ 1)`);
    }
  };
  assertPositiveIntOpt('concurrency');
  assertPositiveIntOpt('timeoutMs');
  assertPositiveIntOpt('repeat');
  assertPositiveIntOpt('judgeRepeat');
  if (obj.holdoutRatio !== undefined) {
    if (typeof obj.holdoutRatio !== 'number' || !Number.isFinite(obj.holdoutRatio) || obj.holdoutRatio <= 0 || obj.holdoutRatio >= 1) {
      throw new Error(`${configPath}: holdoutRatio must be a number in (0, 1)`);
    }
  }
  if (obj.bootstrapSamples !== undefined) {
    if (typeof obj.bootstrapSamples !== 'number'
        || !Number.isFinite(obj.bootstrapSamples)
        || obj.bootstrapSamples < 100
        || !Number.isInteger(obj.bootstrapSamples)) {
      throw new Error(`${configPath}: bootstrapSamples must be an integer ≥ 100`);
    }
  }

  // judgeModels: array of { executor, model } — unified judge config.
  // 1 条 = single judge (no ensemble); ≥ 2 条 = ensemble + inter-judge agreement。空数组 reject。
  // 重复 executor:model 拒绝:ensemble 聚合按 judge id 去重(参见 schema.ts buildEnsembleAggregate),
  // 重复条目会让 N 不可信、agreement 失真,而 grading 又会照样跑 N 次。
  let judgeModelsParsed: import('../types/index.js').JudgeConfig[] | undefined;
  if (obj.judgeModels !== undefined) {
    if (!Array.isArray(obj.judgeModels)) {
      throw new Error(`${configPath}: judgeModels must be an array of {executor, model}`);
    }
    if (obj.judgeModels.length === 0) {
      throw new Error(`${configPath}: judgeModels must have ≥ 1 entry (omit the field for default judge)`);
    }
    judgeModelsParsed = [];
    const seenJudgeKeys = new Set<string>();
    for (const [i, raw] of (obj.judgeModels as unknown[]).entries()) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`${configPath}: judgeModels[${i}] must be an object {executor, model}`);
      }
      const j = raw as Record<string, unknown>;
      if (typeof j.executor !== 'string' || !j.executor) {
        throw new Error(`${configPath}: judgeModels[${i}].executor must be a non-empty string`);
      }
      if (typeof j.model !== 'string' || !j.model) {
        throw new Error(`${configPath}: judgeModels[${i}].model must be a non-empty string`);
      }
      const key = `${j.executor}:${j.model}`;
      if (seenJudgeKeys.has(key)) {
        throw new Error(`${configPath}: judgeModels[${i}] is a duplicate entry "${key}"; ensemble 聚合按 executor:model 去重,重复条目会让 N 不可信、agreement 失真`);
      }
      seenJudgeKeys.add(key);
      judgeModelsParsed.push({ executor: j.executor, model: j.model });
    }
  }

  //  — budget validation. Top-level `budget: { totalUSD?, perSampleUSD?, perSampleMs? }`.
  let budget: EvalBudget | undefined;
  if (obj.budget !== undefined) {
    if (typeof obj.budget !== 'object' || obj.budget === null || Array.isArray(obj.budget)) {
      throw new Error(`${configPath}: budget must be an object`);
    }
    const b = obj.budget as Record<string, unknown>;
    for (const k of ['totalUSD', 'perSampleUSD', 'perSampleMs']) {
      if (b[k] !== undefined
          && (typeof b[k] !== 'number' || !Number.isFinite(b[k]) || b[k] as number <= 0)) {
        throw new Error(`${configPath}: budget.${k} must be a finite number greater than 0`);
      }
    }
    if (b.perSampleMs !== undefined && !Number.isInteger(b.perSampleMs)) {
      throw new Error(`${configPath}: budget.perSampleMs must be an integer`);
    }
    budget = {
      totalUSD: b.totalUSD as number | undefined,
      perSampleUSD: b.perSampleUSD as number | undefined,
      perSampleMs: b.perSampleMs as number | undefined,
    };
  }

  // effort 字段:可选,合法值检查
  let effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  if (obj.effort !== undefined) {
    const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    if (typeof obj.effort !== 'string' || !VALID_EFFORTS.has(obj.effort)) {
      throw new Error(`${configPath}: effort must be one of low/medium/high/xhigh/max (got ${JSON.stringify(obj.effort)})`);
    }
    effort = obj.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }

  // noDiagnostic / skipDoctor:可选 boolean
  if (obj.noDiagnostic !== undefined && typeof obj.noDiagnostic !== 'boolean') {
    throw new Error(`${configPath}: noDiagnostic must be boolean (got ${typeof obj.noDiagnostic})`);
  }
  if (obj.skipDoctor !== undefined && typeof obj.skipDoctor !== 'boolean') {
    throw new Error(`${configPath}: skipDoctor must be boolean (got ${typeof obj.skipDoctor})`);
  }

  return {
    samples: obj.samples as string,
    executor: obj.executor as string | undefined,
    model: obj.model as string | undefined,
    judgeModels: judgeModelsParsed,
    concurrency: obj.concurrency as number | undefined,
    timeoutMs: obj.timeoutMs as number | undefined,
    noCache: obj.noCache as boolean | undefined,
    noJudge: obj.noJudge as boolean | undefined,
    mcpConfig: obj.mcpConfig as string | undefined,
    variants,
    budget,
    repeat: obj.repeat as number | undefined,
    holdoutRatio: obj.holdoutRatio as number | undefined,
    judgeRepeat: obj.judgeRepeat as number | undefined,
    bootstrap: obj.bootstrap as boolean | undefined,
    bootstrapSamples: obj.bootstrapSamples as number | undefined,
    goldDir: obj.goldDir as string | undefined,
    lengthDebias: obj.lengthDebias as boolean | undefined,
    strictBaseline: obj.strictBaseline as boolean | undefined,
    effort,
    noDiagnostic: obj.noDiagnostic as boolean | undefined,
    skipDoctor: obj.skipDoctor as boolean | undefined,
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
    goldDir: config.goldDir ? resolveRel(config.goldDir) : undefined,
    variants: config.variants.map((v) => ({
      ...v,
      // git 变体无 artifact(git.url 是 URL、git.spec 是仓库相对路径,都不按本地路径解析,原样经 ...v 携带)。
      ...(v.artifact !== undefined && {
        artifact: isNonPathExpr(v.artifact) ? v.artifact : (looksLikePath(v.artifact) ? resolveRel(v.artifact) : v.artifact),
      }),
      cwd: v.cwd ? resolveRel(v.cwd) : undefined,
    })),
  };
}
