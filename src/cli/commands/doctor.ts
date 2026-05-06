import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
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

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values, positionals } = parseArgsStrictOrExit({
    args: argv,
    allowPositionals: true,
    options: {
      ...COMMON_OPTIONS,
      json: { type: 'boolean', default: false },
      gate: { type: 'boolean', default: false },
      executor: { type: 'string' },
      model: { type: 'string' },
      samples: { type: 'string' },
      timeout: { type: 'string' },
      html: { type: 'string' },
      'static-only': { type: 'boolean', default: false },
    },
  });

  const target: string | null = positionals[0] ?? null;
  const executorName = (values.executor as string | undefined) ?? 'claude';
  const model = (values.model as string | undefined) ?? 'sonnet';
  const timeoutRaw = values.timeout as string | undefined;
  // 默认 LLM 健康度审计(7 内置维度 + 用户注册的自定义维度);--static-only 切到
  // 离线静态模式:只跑 4 条静态 rule(skill_readable / skill_metadata /
  // dependencies_present / samples_contract_aligned),不调 LLM。后者用于
  // CI 节点没装 claude/codex、本地断网调试等场景。
  const staticOnly = values['static-only'] as boolean;
  const runHealthCheck = !staticOnly;
  // 单次 LLM 会话(7+N 维度,内部多 turn)默认 timeout 600s(10 min)。
  const defaultTimeoutSec = 600;
  const timeoutSec = timeoutRaw != null ? Number(timeoutRaw) : defaultTimeoutSec;
  const timeoutMs = Math.max(1000, Math.floor((Number.isFinite(timeoutSec) ? timeoutSec : defaultTimeoutSec) * 1000));
  const cwd = process.cwd();
  const samplesPath = values.samples ? resolve(values.samples as string) : findDefaultSamplesPath(target, cwd);
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
  // 用户在自己代码 / plugin 里 import dimension-registry 注册自定义维度,
  // 同样会被 composer 拼到 prompt(顺序 = 注册顺序)。
  await import('../../doctor/health/register.js');

  const { runDoctor } = await import('../../doctor/index.js');
  const { renderDoctorReportText, renderDoctorReportJson } = await import('../../doctor/renderer.js');

  // 默认模式过滤掉静态 rule 只留 composer;--static-only 反过来:只留静态 rule
  // 跳过 composer。静态 rule 在 omk eval 里继续当强制 gate,doctor 这条线只
  // 选择性暴露给用户。
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
    // CliExit 透传(防御性,目前 runDoctor 不抛 CliExit,但保持四个 catch 一致)。
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

  const isJson = values.json as boolean;
  const isGate = values.gate as boolean;
  const htmlPath = values.html as string | undefined;

  // --html 与 --json/--gate 可以共存:--html 写文件;同时 stdout/stderr 仍按
  // 主输出格式跑(--json → JSON 到 stdout / --gate → 静默 / 默认 → text 到 stderr)。
  if (htmlPath) {
    const { renderDoctorReportHtml } = await import('../../doctor/html-renderer.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const abs = resolve(htmlPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, renderDoctorReportHtml(report, lang), 'utf8');
    // 通知用户(stderr,不污染 --json 的 stdout)
    console.error(lang === 'zh' ? `HTML 报告已写入: ${abs}` : `HTML report written to: ${abs}`);
  }

  if (isJson) {
    console.log(renderDoctorReportJson(report));
  } else if (isGate) {
    // gate 模式: 静默 stdout, fail 时简短 stderr 摘要(供 CI 抓 exit code)
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
