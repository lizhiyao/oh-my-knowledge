/**
 * omk doctor 引擎入口。
 *
 * runDoctor() 接受 target(单文件 / 目录 / null=cwd 默认),解析出 Artifact 列表,
 * 对每个 artifact 顺序跑全部 rules,聚合为 DoctorReport。
 *
 * fatal-fail 不中断后续 rule 执行(让用户一次看到全貌),但 report.outcome='failed',
 * CLI 据此 exit 1 / abort eval。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFileSuffix } from '../../measurement-artifacts/file-names.js';
import { discoverVariants, resolveArtifacts } from '../../inputs/skill-loader.js';
import type { Artifact } from '../contracts.js';
import type {
  DoctorContext,
  DoctorOutcome,
  DoctorReport,
  DoctorRuleLike,
  DoctorRuleResult,
  DoctorRunOptions,
  DoctorSkillReport,
  DoctorSkillStatus,
} from './contracts.js';
import { DOCTOR_REPORT_SCHEMA_VERSION } from './report-schema.js';
import { isComposerRule } from './rule-kind.js';
import { getRegisteredRules } from './rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * 把 doctor 的 target 参数解析成 Artifact 列表。
 * - null/undefined: 默认在 cwd/skills 下批量;若不存在则在 cwd 自身找
 * - 文件 (.md): 单 artifact,用 file-path 模式
 * - 目录: discoverVariants 后批量
 */
export function resolveDoctorTargets(target: string | null | undefined, cwd: string): Artifact[] {
  if (target == null) {
    const skillsDir = join(cwd, 'skills');
    if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
      const variants = discoverVariants(skillsDir).filter((v) => v !== 'baseline');
      return variants.length > 0 ? resolveArtifacts(skillsDir, variants, { strictBaseline: false, materialize: false }) : [];
    }
    const variants = discoverVariants(cwd).filter((v) => v !== 'baseline');
    return variants.length > 0 ? resolveArtifacts(cwd, variants, { strictBaseline: false, materialize: false }) : [];
  }

  const absTarget = resolve(target);
  if (!existsSync(absTarget)) {
    throw new Error(`doctor target not found: ${target}`);
  }
  const stat = statSync(absTarget);
  if (stat.isFile() && absTarget.endsWith('.md')) {
    // 单文件:用 file-path 模式(走 resolveArtifacts 的 "包含 /" 分支)
    return resolveArtifacts(dirname(absTarget), [absTarget], { strictBaseline: false, materialize: false });
  }
  if (stat.isDirectory()) {
    // 目录自身就是 directory-skill (含 SKILL.md): 按单个 skill 解析,
    // 让 skill-loader 的 directory-skill 分支命中 (设 skillRoot,
    // 让相对路径 asset 能锚到 skill 根目录)。
    // 否则 discoverVariants 会把 SKILL.md 当成名为 SKILL 的 variant,
    // skillRoot 丢失,assets/foo.md 这类相对依赖会锚到 doctor 的 cwd 而不是
    // skill 目录, 误报缺文件。
    if (existsSync(join(absTarget, 'SKILL.md'))) {
      return resolveArtifacts(dirname(absTarget), [basename(absTarget)], { strictBaseline: false, materialize: false });
    }
    const variants = discoverVariants(absTarget).filter((v) => v !== 'baseline');
    return variants.length > 0 ? resolveArtifacts(absTarget, variants, { strictBaseline: false, materialize: false }) : [];
  }
  throw new Error(`doctor target must be a .md file or directory: ${target}`);
}

// ---------------------------------------------------------------------------
// Rule execution
// ---------------------------------------------------------------------------

function classifySkillStatus(results: DoctorRuleResult[]): DoctorSkillStatus {
  // status=fail 时按 severity 分流:fatal 升 skill fail,非 fatal(warn / info)
  // 至少 roll up 到 skill warn — 否则 health composer 对 warn 级维度产出
  // status=fail 会被错误聚合成 pass,gate 静默放行。status=warn 一律 roll
  // 到 skill warn(severity 不再作权重二次降级)。
  let hasFatalFail = false;
  let hasWarn = false;
  for (const r of results) {
    if (r.status === 'fail') {
      if (r.severity === 'fatal') hasFatalFail = true;
      else hasWarn = true;
    } else if (r.status === 'warn') {
      hasWarn = true;
    }
  }
  if (hasFatalFail) return 'fail';
  if (hasWarn) return 'warn';
  return 'pass';
}

async function runRulesOnArtifact(
  artifact: Artifact,
  rules: DoctorRuleLike[],
  ctxBase: Omit<DoctorContext, 'artifact'>,
): Promise<DoctorRuleResult[]> {
  const results: DoctorRuleResult[] = [];
  const ctx = { ...ctxBase, artifact };
  for (const rule of rules) {
    const start = Date.now();
    if (isComposerRule(rule)) {
      // ComposerRule: 一次 checkAll() 产出多条 outcome,展开成 N+1 条 result,
      // 共享同一个 groupId(= composer.id),renderer 用它把多条 result 视为
      // 一个组(eg. 健康度体检的 7+1 个 sub-result)。
      try {
        const outcomes = await rule.checkAll(ctx);
        const took = Date.now() - start;
        for (const oc of outcomes) {
          results.push({
            ruleId: `${rule.id}:${oc.subId}`,
            groupId: rule.id,
            severity: oc.severity ?? rule.severity,
            labelKey: oc.labelKey ?? rule.labelKey,
            status: oc.status,
            message: oc.message,
            hint: oc.hint,
            detail: oc.detail,
            // composer 只给整体耗时一次;均摊到每条 result 没意义,直接复用。
            durationMs: took,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          ruleId: `${rule.id}:_summary`,
          groupId: rule.id,
          severity: rule.severity,
          labelKey: rule.labelKey,
          status: 'fail',
          message: `composer crashed: ${message.slice(0, 160)}`,
          hint: undefined,
          detail: { ruleCrash: true, error: message },
          durationMs: Date.now() - start,
        });
      }
      continue;
    }

    // 普通 DoctorRule(原路径)
    try {
      const outcome = await rule.check(ctx);
      results.push({
        ruleId: rule.id,
        severity: rule.severity,
        labelKey: rule.labelKey,
        durationMs: Date.now() - start,
        ...outcome,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        ruleId: rule.id,
        severity: rule.severity,
        labelKey: rule.labelKey,
        status: 'fail',
        message: `rule crashed: ${message.slice(0, 160)}`,
        hint: undefined,
        detail: { ruleCrash: true, error: message },
        durationMs: Date.now() - start,
      });
    }
  }
  return results;
}

function inferSkillPath(artifact: Artifact, baseDir: string): string {
  if (artifact.locator) return artifact.locator;
  if (artifact.skillRoot) return artifact.skillRoot;
  // fallback: 拼一个推断路径(用于 report 显示,不参与 io)
  return join(baseDir, artifact.name.endsWith('.md') ? artifact.name : `${artifact.name}.md`);
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

function nextReportId(): string {
  return `doctor-${runFileSuffix()}`;
}

function findPackageJson(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(startDir, '..', 'package.json');
}

function readCliVersion(): string {
  const envVersion = process.env.npm_package_version;
  if (envVersion) return envVersion;
  try {
    const pkg = JSON.parse(readFileSync(findPackageJson(__dirname), 'utf-8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch { /* fall through */ }
  return '0.0.0';
}

export async function runDoctor(opts: DoctorRunOptions): Promise<DoctorReport> {
  // 默认规则 = 内置 + registerRule() 注册的 custom。test 注入走 opts.rules。
  const effectiveRules = opts.rules && opts.rules.length > 0 ? opts.rules : getRegisteredRules();

  // artifacts 显式提供时跳过 target 解析（嵌入 eval 的路径用，
  // 避免扫整个 skillDir)。空数组合法且明确 — 表示"本次评测没 skill 需要 doctor"
  // (e.g. baseline-only 或纯 runtime-context-only run), doctor 不该再扫
  // skillDir 找无关草稿。只有 artifacts 完全 undefined 时才 fallback 到 target 解析。
  const artifacts = opts.artifacts !== undefined
    ? opts.artifacts
    : resolveDoctorTargets(opts.target, opts.cwd);

  // dependencyCwd 选择优先级与 Evaluation Core production preflight 的 dependency check 规则
  // 严格对齐: artifact.cwd > opts.dependencyCwd (CLI 传 skillDir) > opts.cwd。
  // 不对齐会让 requires.files / requires.preflight 在 doctor 和 eval 之间产生
  // false-positive (文件在 skillDir 存在 doctor 误 fail) 或 false-negative
  // (文件只在项目 cwd 存在 doctor pass 但 eval fail) 不一致。
  const dependencyCwd = artifacts.find((a) => a.cwd)?.cwd
    ?? opts.dependencyCwd
    ?? opts.cwd;

  const ctxBase: Omit<DoctorContext, 'artifact'> = {
    samples: opts.samples,
    requires: opts.requires,
    executorName: opts.executorName,
    model: opts.model,
    cwd: opts.cwd,
    dependencyCwd,
    lang: opts.lang,
    timeoutMs: opts.timeoutMs,
    effort: opts.effort,
    runHealthCheck: opts.runHealthCheck ?? false,
    healthSamples: opts.healthSamples,
    healthMerge: opts.healthMerge,
    healthConcurrency: opts.healthConcurrency,
  };

  const skillReports: DoctorSkillReport[] = [];
  const totals = { pass: 0, warn: 0, fail: 0 };
  const ruleStats = { pass: 0, warn: 0, fail: 0, skipped: 0, total: 0 };

  const total = artifacts.length;
  let index = 0;
  for (const artifact of artifacts) {
    index += 1;
    const skillName = basename(artifact.name).replace(/\.md$/, '');
    opts.onProgress?.({ phase: 'skill_start', index, total, skillName });
    const startedAt = Date.now();
    const results = await runRulesOnArtifact(artifact, effectiveRules, ctxBase);
    const status = classifySkillStatus(results);
    skillReports.push({
      skillName,
      skillPath: inferSkillPath(artifact, opts.cwd),
      results,
      status,
    });
    totals[status] += 1;
    for (const r of results) {
      ruleStats[r.status] += 1;
      ruleStats.total += 1;
    }
    opts.onProgress?.({ phase: 'skill_done', index, total, skillName, status, durationMs: Date.now() - startedAt });
  }

  // Single-enum verdict for CI / agent code. fatal-fail dominates;
  // warnings_only when no fatal-fail but at least one warn; otherwise passed.
  const outcome: DoctorOutcome = totals.fail > 0
    ? 'failed'
    : totals.warn > 0
      ? 'warnings_only'
      : 'passed';

  return {
    kind: 'doctor',
    schemaVersion: DOCTOR_REPORT_SCHEMA_VERSION,
    id: nextReportId(),
    timestamp: new Date().toISOString(),
    cliVersion: readCliVersion(),
    cwd: opts.cwd,
    executorName: opts.executorName,
    model: opts.model,
    skills: skillReports,
    outcome,
    totals,
    ruleStats,
  };
}
