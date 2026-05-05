import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { DependencyRequirements } from '../../eval-core/dependency-checker.js';
import type { Sample } from '../../types/index.js';

function findDefaultSamplesPath(cwd: string): string | null {
  for (const name of ['eval-samples.json', 'eval-samples.yaml', 'eval-samples.yml']) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
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
      timeout: { type: 'string' },
    },
  });

  const target: string | null = positionals[0] ?? null;
  const executorName = (values.executor as string | undefined) ?? 'claude';
  const model = (values.model as string | undefined) ?? 'sonnet';
  const timeoutRaw = values.timeout as string | undefined;
  const timeoutSec = timeoutRaw != null ? Number(timeoutRaw) : 8;
  const timeoutMs = Math.max(1000, Math.floor((Number.isFinite(timeoutSec) ? timeoutSec : 8) * 1000));
  const cwd = process.cwd();
  const samplesPath = findDefaultSamplesPath(cwd);
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

  const { runDoctor } = await import('../../doctor/index.js');
  const { renderDoctorReportText, renderDoctorReportJson } = await import('../../doctor/renderer.js');

  let report;
  try {
    report = await runDoctor({
      target,
      cwd,
      executorName,
      model,
      timeoutMs,
      lang,
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
    renderDoctorReportText(report, lang);
  }

  throw new CliExit(report.outcome === 'failed' ? 1 : 0);
}
