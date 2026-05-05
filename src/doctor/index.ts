/**
 * omk doctor 引擎入口。
 *
 * runDoctor() 接受 target(单文件 / 目录 / null=cwd 默认),解析出 Artifact 列表,
 * 对每个 artifact 顺序跑全部 rules,聚合为 DoctorReport。
 *
 * fatal-fail 不中断后续 rule 执行(让用户一次看到全貌),但 report.outcome='failed',
 * CLI 据此 exit 1 / abort eval。
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { discoverVariants, resolveArtifacts } from '../inputs/skill-loader.js';
import type {
  Artifact,
  DoctorContext,
  DoctorOutcome,
  DoctorReport,
  DoctorRule,
  DoctorRuleResult,
  DoctorRunOptions,
  DoctorSkillReport,
  DoctorSkillStatus,
} from '../types/index.js';
import { DOCTOR_REPORT_SCHEMA_VERSION } from '../types/doctor.js';
import { getRegisteredRules } from './rules.js';

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
      return variants.length > 0 ? resolveArtifacts(skillsDir, variants, { strictBaseline: false }) : [];
    }
    const variants = discoverVariants(cwd).filter((v) => v !== 'baseline');
    return variants.length > 0 ? resolveArtifacts(cwd, variants, { strictBaseline: false }) : [];
  }

  const absTarget = resolve(target);
  if (!existsSync(absTarget)) {
    throw new Error(`doctor target not found: ${target}`);
  }
  const stat = statSync(absTarget);
  if (stat.isFile() && absTarget.endsWith('.md')) {
    // 单文件:用 file-path 模式(走 resolveArtifacts 的 "包含 /" 分支)
    return resolveArtifacts(dirname(absTarget), [absTarget], { strictBaseline: false });
  }
  if (stat.isDirectory()) {
    // 目录自身就是 directory-skill (含 SKILL.md): 按单个 skill 解析,
    // 让 skill-loader 的 directory-skill 分支命中 (设 skillRoot,
    // 让相对路径 asset 能锚到 skill 根目录)。
    // 否则 discoverVariants 会把 SKILL.md 当成名为 SKILL 的 variant,
    // skillRoot 丢失,assets/foo.md 这类相对依赖会锚到 doctor 的 cwd 而不是
    // skill 目录, 误报缺文件。
    if (existsSync(join(absTarget, 'SKILL.md'))) {
      return resolveArtifacts(dirname(absTarget), [basename(absTarget)], { strictBaseline: false });
    }
    const variants = discoverVariants(absTarget).filter((v) => v !== 'baseline');
    return variants.length > 0 ? resolveArtifacts(absTarget, variants, { strictBaseline: false }) : [];
  }
  throw new Error(`doctor target must be a .md file or directory: ${target}`);
}

// ---------------------------------------------------------------------------
// Rule execution
// ---------------------------------------------------------------------------

function classifySkillStatus(results: DoctorRuleResult[]): DoctorSkillStatus {
  let hasFatalFail = false;
  let hasWarn = false;
  for (const r of results) {
    if (r.severity === 'fatal' && r.status === 'fail') hasFatalFail = true;
    if (r.status === 'warn') hasWarn = true;
  }
  if (hasFatalFail) return 'fail';
  if (hasWarn) return 'warn';
  return 'pass';
}

async function runRulesOnArtifact(
  artifact: Artifact,
  rules: DoctorRule[],
  ctxBase: Omit<DoctorContext, 'artifact'>,
): Promise<DoctorRuleResult[]> {
  const results: DoctorRuleResult[] = [];
  for (const rule of rules) {
    const start = Date.now();
    try {
      const outcome = await rule.check({ ...ctxBase, artifact });
      results.push({
        ruleId: rule.id,
        severity: rule.severity,
        labelKey: rule.labelKey,
        durationMs: Date.now() - start,
        ...outcome,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // rule 自身崩溃也算 fail,不让 doctor 整体挂掉
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

let reportIdCounter = 0;
function nextReportId(): string {
  reportIdCounter += 1;
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  return `doctor-${ts}-${reportIdCounter}`;
}

function readCliVersion(): string {
  // 不依赖 package.json import(避免 type 解析复杂度);用环境变量或退回 'unknown'
  return process.env.npm_package_version ?? '0.0.0';
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

  // dependencyCwd 选择优先级与 evaluation-pipeline.ts 的 dependency check 规则
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
  };

  const skillReports: DoctorSkillReport[] = [];
  const totals = { pass: 0, warn: 0, fail: 0 };
  const ruleStats = { pass: 0, warn: 0, fail: 0, skipped: 0, total: 0 };

  for (const artifact of artifacts) {
    const results = await runRulesOnArtifact(artifact, effectiveRules, ctxBase);
    const status = classifySkillStatus(results);
    skillReports.push({
      skillName: basename(artifact.name).replace(/\.md$/, ''),
      skillPath: inferSkillPath(artifact, opts.cwd),
      results,
      status,
    });
    totals[status] += 1;
    for (const r of results) {
      ruleStats[r.status] += 1;
      ruleStats.total += 1;
    }
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
