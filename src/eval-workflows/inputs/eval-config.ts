import { EvalConfigSchema } from './contracts/config-schema.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { parseYaml } from './load-samples.js';
import type {
  EvalConfig,
  EvalConfigVariant,
} from './contracts/config.js';
import type { VariantSpec } from './contracts/variant.js';


/**
 * Machine-enumerable public input surface accepted by the current eval config
 * validator. Nested object containers are included because they are user-facing
 * source keys too; #451's registry guard requires every path to be classified.
 */
export { EVAL_CONFIG_SCHEMA_SOURCE_PATHS } from './contracts/config-schema.js';

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
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (Object.hasOwn(record, 'noCache')) throw new Error(      `${configPath}: noCache 已移除。当前产品评测已禁用执行与评分缓存，请删除该字段。`);
    if (record.judgeModel !== undefined || record.judgeExecutor !== undefined) {
      throw new Error(`${configPath}: judgeModel and judgeExecutor were removed in v0.25; use judgeModels instead.`);
    }
    if (record.blind !== undefined) throw new Error(`${configPath}: \`blind\` was removed; delete this field.`);
  }
  const result = EvalConfigSchema.safeParse(parsed);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const parts = issue.code === 'unrecognized_keys' ? [...issue.path, issue.keys[0]] : issue.path;
  const field = parts.map((part, index) => typeof part === 'number'
    ? `[${part}]` : `${index ? '.' : ''}${String(part)}`).join('');
  const label = parts.length === 1 && (field === 'samples' || field === 'variants') ? `'${field}'` : field;
  const message = issue.code === 'unrecognized_keys' ? 'is not supported' : issue.message;
  throw new Error(`${configPath}: ${label ? label + ' ' : ''}${message}`);
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
