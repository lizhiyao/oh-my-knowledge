import { resolve, join } from 'node:path';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import { parseLastWindow } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values: rawValues, positionals } = parseArgsStrictOrExit({
    args: argv,
    allowPositionals: true,
    options: {
      ...COMMON_OPTIONS,
      kb: { type: 'string' },
      last: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      skills: { type: 'string' },
      'output-dir': { type: 'string' },
    },
  });
  // 该 handler options 全是 string-typed (无 boolean), 收紧 cast 让 caller 直接 use values.xxx 当 string 用。
  const values = rawValues as Record<string, string | undefined>;
  const dir = positionals[0];
  if (!dir) {
    console.error(tCli('cli.help.analyze_usage', lang));
    process.exit(1);
  }
  const tracePath = resolve(dir);

  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  if (!existsSync(tracePath)) {
    console.error(`Trace path does not exist: ${tracePath}`);
    process.exit(1);
  }

  // 时间窗: --from/--to 优先, --last fallback
  let from: string | undefined = values.from;
  if (!from && values.last) {
    const inferred = parseLastWindow(values.last);
    if (!inferred) {
      console.error(`Invalid --last format: "${values.last}". Expected e.g. "7d" / "24h" / "30m".`);
      process.exit(1);
    }
    from = inferred;
  }
  const to: string | undefined = values.to;
  const skills = values.skills ? values.skills.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  console.log(`[omk] analyzing ${tracePath}...`);
  const { computeSkillHealthReport } = await import('../../observability/skill-health-analyzer.js');
  const report = computeSkillHealthReport(tracePath, {
    kbRoot: values.kb ? resolve(values.kb) : undefined,
    from,
    to,
    skills,
  });

  // JSON 是主产物; HTML 由 report server 的 /analyses/:id 按需渲染 (和 bench run 一致)
  const outDir = resolve(values['output-dir'] || join(process.env.HOME || '.', '.oh-my-knowledge', 'analyses'));
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = join(outDir, `${timestamp}-skill-health.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // 控制台摘要
  const { sessionCount, segmentCount, toolCallCount, toolFailureRate } = report.meta;
  console.log('');
  console.log(`sessions: ${sessionCount} · segments: ${segmentCount} · tool calls: ${toolCallCount} · fail rate: ${(toolFailureRate * 100).toFixed(1)}%`);
  console.log(`overall: gapRate ${(report.overall.gapRate * 100).toFixed(1)}% · weightedGapRate ${(report.overall.weightedGapRate * 100).toFixed(1)}% · health: ${report.overall.healthBand}`);
  console.log('');
  const skillRows = Object.values(report.bySkill)
    .sort((a, b) => b.segmentCount - a.segmentCount)
    .slice(0, 10)
    .map((s) => `  ${s.skillName.padEnd(24)} segs=${String(s.segmentCount).padStart(4)}  gapRate=${String(Math.round(s.gap.gapRate * 100) + '%').padStart(4)}  weighted=${String(Math.round(s.gap.weightedGapRate * 100) + '%').padStart(4)}${s.coverage ? `  cov=${Math.round(s.coverage.fileCoverageRate * 100)}%` : ''}`);
  console.log('top skills:');
  console.log(skillRows.join('\n'));
  console.log('');
  console.log(`report written to: ${jsonPath}`);
  console.log(tCli('cli.analyze.view_in_browser', lang));
}
