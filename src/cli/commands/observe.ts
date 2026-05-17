import { CliExit } from '../cli-exit.js';
import { resolve, join } from 'node:path';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import { parseLastWindow } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === 'ingest') {
    await executeIngest(rest);
    return;
  }
  if (sub === 'inbox') {
    await executeInbox(rest);
    return;
  }
  if (sub === 'show') {
    await executeShow(rest);
    return;
  }

  await executeHealth(argv);
}

export async function executeIngest(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values: rawValues, positionals } = parseArgsStrictOrExit({
    args: argv,
    allowPositionals: true,
    options: {
      ...COMMON_OPTIONS,
      'output-dir': { type: 'string' },
    },
  });
  const values = rawValues as Record<string, string | undefined>;
  const dir = positionals[0];
  if (!dir) {
    console.error(tCli('cli.help.observe', lang).trim());
    throw new CliExit(1);
  }
  const tracePath = resolve(dir);
  const { existsSync } = await import('node:fs');
  if (!existsSync(tracePath)) {
    console.error(`Trace path does not exist: ${tracePath}`);
    throw new CliExit(1);
  }
  const { buildObservationInboxReport, saveObservationInboxReport, DEFAULT_OBSERVATIONS_DIR } = await import('../../observability/inbox.js');
  const outDir = resolve(values['output-dir'] || DEFAULT_OBSERVATIONS_DIR);
  const { loadObservationReviewState } = await import('../../observability/review-state.js');
  const report = buildObservationInboxReport(tracePath, { reviewState: loadObservationReviewState(outDir) });
  const path = saveObservationInboxReport(report, outDir);
  console.log(JSON.stringify(report, null, 2));
  process.stderr.write(`observe inbox written to: ${path}\n`);
}

export async function executeInbox(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values: rawValues } = parseArgsStrictOrExit({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      'input-dir': { type: 'string' },
      skill: { type: 'string' },
      limit: { type: 'string' },
      explore: { type: 'string' },
      'include-noise': { type: 'boolean' },
      'by-skill': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const values = rawValues as Record<string, string | boolean | undefined>;
  const { queryObservationInbox, selectExploreInboxItems, loadLatestObservationInboxReports, summarizeObservationInboxBySkill, DEFAULT_OBSERVATIONS_DIR } = await import('../../observability/inbox.js');
  const dir = resolve((values['input-dir'] as string | undefined) || DEFAULT_OBSERVATIONS_DIR);
  let items = queryObservationInbox(dir);
  if (values.skill) {
    items = items.filter((item) => item.skillName === values.skill);
  }
  if (values['by-skill'] === true) {
    const reports = values.skill
      ? loadLatestObservationInboxReports(dir).map((report) => ({
        ...report,
        meta: {
          ...report.meta,
          skillInvocationCounts: pickSkillCount(report.meta.skillInvocationCounts, String(values.skill)),
          skillSessionCounts: pickSkillCount(report.meta.skillSessionCounts, String(values.skill)),
          skillInvocationLastSeen: pickSkillString(report.meta.skillInvocationLastSeen, String(values.skill)),
          skillToolCallCounts: pickSkillToolCounts(report.meta.skillToolCallCounts, String(values.skill)),
        },
      }))
      : loadLatestObservationInboxReports(dir);
    const rows = summarizeObservationInboxBySkill(items, reports);
    if (values.json) {
      console.log(JSON.stringify({ kind: 'observe-inbox-by-skill', rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(lang === 'zh' ? 'observe inbox 为空' : 'observe inbox is empty');
      return;
    }
    console.log(lang === 'zh' ? 'observe inbox by skill:' : 'observe inbox by skill:');
    for (const row of rows) {
      console.log(`- ${row.skillName} invocations=${row.invocationCount} sessions=${row.sessionCount} processFindings=${row.observationCount} high=${row.highCount} medium=${row.mediumCount} low=${row.lowCount} noise=${row.noiseCount}${row.latestSeen ? ` latest=${row.latestSeen}` : ''}`);
    }
    return;
  }
  if (values.explore) {
    const n = Math.max(1, Number(values.explore) || 10);
    items = selectExploreInboxItems(items, n, values['include-noise'] === true);
  } else {
    const limit = Math.max(1, Number(values.limit ?? 20) || 20);
    items = items.slice(0, limit);
  }
  if (values.json) {
    console.log(JSON.stringify({ kind: 'observe-inbox-query', items }, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log(lang === 'zh' ? 'observe inbox 为空' : 'observe inbox is empty');
    return;
  }
  console.log(lang === 'zh' ? 'observe inbox:' : 'observe inbox:');
  for (const item of items) {
    const evidence = item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || item.evidence.outputSnippet || '';
    const artifactVersion = item.artifactVersion === 'unknown' ? '⚠ unknown' : item.artifactVersion;
    console.log(`- [${item.severity}] (${item.sourceKind}) ${item.skillName} ${item.signalType}/${item.signalSubtype} x${item.occurrences} confidence=${item.confidence.toFixed(2)} attribution=${item.attributionConfidence.toFixed(2)}`);
    console.log(`  lastSeen=${item.lastSeen} version=${artifactVersion}`);
    console.log(`  reason=${item.severityReasonCode ?? 'unknown'}`);
    if (evidence) console.log(`  evidence=${evidence.slice(0, 180)}`);
  }
  console.log('');
  console.log(lang === 'zh'
    ? 'Tip: omk observe inbox --explore 10  # 抽样查看 medium/low 长尾'
    : 'Tip: omk observe inbox --explore 10  # sample medium/low long-tail items');
  console.log(lang === 'zh'
    ? 'Tip: omk observe inbox --explore 10 --include-noise  # 显式包含 noise 桶'
    : 'Tip: omk observe inbox --explore 10 --include-noise  # explicitly include the noise bucket');
}

function pickSkillCount(value: Record<string, number> | undefined, skillName: string): Record<string, number> | undefined {
  if (!value || value[skillName] == null) return undefined;
  return { [skillName]: value[skillName] };
}

function pickSkillString(value: Record<string, string> | undefined, skillName: string): Record<string, string> | undefined {
  if (!value || value[skillName] == null) return undefined;
  return { [skillName]: value[skillName] };
}

function pickSkillToolCounts(value: Record<string, Record<string, number>> | undefined, skillName: string): Record<string, Record<string, number>> | undefined {
  if (!value || value[skillName] == null) return undefined;
  return { [skillName]: value[skillName] };
}

export async function executeShow(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values: rawValues, positionals } = parseArgsStrictOrExit({
    args: argv,
    allowPositionals: true,
    options: {
      ...COMMON_OPTIONS,
      'input-dir': { type: 'string' },
    },
  });
  const id = positionals[0];
  if (!id) {
    console.error(lang === 'zh' ? '用法：omk observe show <inbox_id> [--input-dir <path>]' : 'Usage: omk observe show <inbox_id> [--input-dir <path>]');
    throw new CliExit(1);
  }
  const values = rawValues as Record<string, string | undefined>;
  const { findObservationInboxItem, formatObservationShow, DEFAULT_OBSERVATIONS_DIR } = await import('../../observability/inbox.js');
  const dir = resolve(values['input-dir'] || DEFAULT_OBSERVATIONS_DIR);
  const item = findObservationInboxItem(id, dir);
  if (!item) {
    console.error(lang === 'zh' ? `未找到 observation：${id}` : `Observation not found: ${id}`);
    throw new CliExit(1);
  }
  console.log(formatObservationShow(item));
}

export async function executeHealth(argv: string[]): Promise<void> {
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
    console.error(tCli('cli.help.observe', lang).trim());
    throw new CliExit(1);
  }
  const tracePath = resolve(dir);

  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  if (!existsSync(tracePath)) {
    console.error(`Trace path does not exist: ${tracePath}`);
    throw new CliExit(1);
  }

  // 时间窗: --from/--to 优先, --last fallback
  let from: string | undefined = values.from;
  if (!from && values.last) {
    const inferred = parseLastWindow(values.last);
    if (!inferred) {
      console.error(`Invalid --last format: "${values.last}". Expected e.g. "7d" / "24h" / "30m".`);
      throw new CliExit(1);
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

  // JSON 是主产物；HTML 由 report server 的 /analyses/:id 按需渲染。
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
  console.log(tCli('cli.observe.view_hint', lang));
}
