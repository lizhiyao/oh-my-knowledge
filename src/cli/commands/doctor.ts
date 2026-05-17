import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { tCli, type CliLang } from '../i18n.js';
import type { DoctorArgs, DoctorFlags } from '../types/cmd-flags.js';
import type { DependencyRequirements } from '../../eval-core/dependency-checker.js';
import type { Sample } from '../../types/index.js';

const DEFAULT_SAMPLE_FILENAMES = ['eval-samples.json', 'eval-samples.yaml', 'eval-samples.yml'] as const;

function findSamplesInDir(dir: string): string | null {
  for (const name of DEFAULT_SAMPLE_FILENAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sampleSearchDirs(target: string | null, cwd: string): string[] {
  const dirs: string[] = [];
  const add = (dir: string): void => {
    const abs = resolve(dir);
    if (!dirs.includes(abs)) dirs.push(abs);
  };
  if (target) {
    const absTarget = resolve(target);
    if (existsSync(absTarget)) {
      const stat = statSync(absTarget);
      if (stat.isDirectory()) {
        add(absTarget);
        add(dirname(absTarget));
        add(dirname(dirname(absTarget)));
      } else {
        const parent = dirname(absTarget);
        add(parent);
        add(dirname(parent));
      }
    }
  }
  add(cwd);
  return dirs;
}

function findDefaultSamplesPath(target: string | null, cwd: string): string | null {
  for (const dir of sampleSearchDirs(target, cwd)) {
    const samplesPath = findSamplesInDir(dir);
    if (samplesPath) return samplesPath;
  }
  return null;
}

export async function runDoctorCommand(
  args: DoctorArgs,
  flags: DoctorFlags,
  lang: CliLang,
): Promise<void> {
  const target: string | null = args.target ?? null;
  const executorName = flags.executor ?? 'claude';
  const model = flags.model ?? 'sonnet';
  // 默认 LLM 健康度审计(7 内置维度 + 用户注册的自定义维度);--static-only 切到
  // 离线静态模式:只跑 4 条静态 rule,不调 LLM。CI 节点没装 claude/codex、本地断网
  // 调试等场景。
  const staticOnly = flags['static-only'];
  const runHealthCheck = !staticOnly;
  // 单次 LLM 会话(7+N 维度,内部多 turn)默认 timeout 600s(10 min)。
  const defaultTimeoutSec = 600;
  const timeoutSec = flags.timeout != null ? Number(flags.timeout) : defaultTimeoutSec;
  const timeoutMs = Math.max(
    1000,
    Math.floor((Number.isFinite(timeoutSec) ? timeoutSec : defaultTimeoutSec) * 1000),
  );

  const cwd = process.cwd();
  const samplesPath = flags.samples ? resolve(flags.samples) : findDefaultSamplesPath(target, cwd);
  let samples: Sample[] | undefined;
  let requires: DependencyRequirements | undefined;
  if (samplesPath) {
    try {
      const { loadSamples } = await import('../../inputs/load-samples.js');
      const loaded = loadSamples(samplesPath);
      samples = loaded.samples;
      requires = loaded.requires;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(tCli('cli.common.warn_load_samples_failed', lang, { path: samplesPath, message: msg }));
    }
  }

  // 副作用 import: 注册 7 内置维度 spec + skill_health composer rule。
  await import('../../doctor/health/register.js');

  const { runDoctor } = await import('../../doctor/index.js');
  const { renderDoctorReportText, renderDoctorReportJson } = await import('../../doctor/renderer.js');
  const { getRegisteredRules } = await import('../../doctor/rules.js');
  const { isComposerRule } = await import('../../types/doctor.js');
  const rulesOverride = staticOnly
    ? getRegisteredRules().filter((r) => !isComposerRule(r))
    : getRegisteredRules().filter(isComposerRule);

  let report;
  try {
    report = await runDoctor({
      target,
      cwd,
      executorName,
      model,
      timeoutMs,
      lang,
      runHealthCheck,
      rules: rulesOverride,
      samples,
      requires,
    });
  } catch (err) {
    if (err instanceof CliExit) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(tCli('cli.doctor.no_skill_found', lang, { path: target ?? cwd }));
    console.error(`(${msg})`);
    throw new CliExit(1);
  }

  if (report.skills.length === 0) {
    console.error(tCli('cli.doctor.no_skill_found', lang, { path: target ?? cwd }));
    throw new CliExit(1);
  }

  if (flags.html) {
    const { renderDoctorReportHtml } = await import('../../doctor/html-renderer.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const abs = resolve(flags.html);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, renderDoctorReportHtml(report, lang), 'utf8');
    console.error(lang === 'zh' ? `HTML 报告已写入: ${abs}` : `HTML report written to: ${abs}`);
  }

  if (flags.json) {
    console.log(renderDoctorReportJson(report));
  } else if (flags.gate) {
    if (report.outcome === 'failed') {
      const summary = lang === 'zh'
        ? `doctor failed: ${report.totals.fail} 个 skill 未通过 (${report.totals.warn} warn / ${report.totals.pass} pass)`
        : `doctor failed: ${report.totals.fail} skills did not pass (${report.totals.warn} warn / ${report.totals.pass} pass)`;
      console.error(summary);
    }
  } else {
    if (samplesPath && samples) {
      process.stderr.write(tCli('cli.doctor.samples_detected', lang, { path: samplesPath }) + '\n');
    }
    renderDoctorReportText(report, lang);
  }

  throw new CliExit(report.outcome === 'failed' ? 1 : 0);
}
