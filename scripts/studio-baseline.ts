// scripts/studio-baseline.ts — Studio 容量与性能基线（issue #836 1.2）。
//
// 在小 / 中 / 大三档代表性数据集上，经真实 createReportServer(port 0) 测量：
// 冷 / 热查询耗时、目录扫描成本（含在冷响应内）、响应体积、并发下事件循环延迟。
// 产物是纯 markdown 表格，供 docs/explanation/studio-performance-baseline.md 引用。
//
// 运行：yarn studio:baseline（先 build，再执行 dist-scripts/studio-baseline.js）。
// 复现条件：同一台机器、同一 commit；数值只做同条件前后对比，不做跨机绝对值对比。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface BaselineScale {
  readonly name: 'small' | 'medium' | 'large';
  /** 不同 skill 数量；每份 observe-health 报告覆盖全部 skill（与真实产物一致）。 */
  readonly skills: number;
  /** observe-health bundle 数（= analyses 目录扫描 + 解析的文件数）。 */
  readonly analyses: number;
  /** doctor bundle 数，每份覆盖一段 skill 切片。 */
  readonly doctorReports: number;
  /** 最新 inbox 报告的信号条目数（聚合成本）。 */
  readonly inboxItems: number;
  /** inbox reports/ 目录文件总数（目录扫描成本；旧报告各 1 条）。 */
  readonly inboxReports: number;
}

export const BASELINE_SCALES: readonly BaselineScale[] = [
  { name: 'small', skills: 5, analyses: 10, doctorReports: 5, inboxItems: 20, inboxReports: 2 },
  { name: 'medium', skills: 30, analyses: 60, doctorReports: 20, inboxItems: 300, inboxReports: 10 },
  { name: 'large', skills: 100, analyses: 200, doctorReports: 60, inboxItems: 3000, inboxReports: 30 },
];

export function skillNameAt(scale: BaselineScale, index: number): string {
  return `baseline-skill-${String(index % scale.skills).padStart(3, '0')}`;
}

function timestampAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 60_000).toISOString();
}

/**
 * 构造聚合自洽的 observe-health 报告：meta 的 segment/tool 计数与各 skill
 * 之和一致，失败率按解析器要求的 4 位小数以 1/10 精确表示。字段口径见
 * src/observability/skill-health/report.ts 的一致性校验。
 */
export function buildObserveHealthReport(scale: BaselineScale, index: number): unknown {
  const bySkill: Record<string, unknown> = {};
  for (let skillIndex = 0; skillIndex < scale.skills; skillIndex += 1) {
    const skillName = skillNameAt(scale, skillIndex);
    bySkill[skillName] = {
      skillName,
      segmentCount: 4,
      toolCallCount: 10,
      toolFailureCount: 1,
      toolFailureRate: 0.1,
      gap: { gapRate: 0, weightedGapRate: 0, signals: [] },
    };
  }
  const generatedAt = timestampAt(index);
  return {
    meta: {
      tracePath: join('baseline', `trace-${index}.jsonl`),
      kbPath: null,
      sessionCount: 2,
      segmentCount: 4 * scale.skills,
      messageCount: 8 * scale.skills,
      toolCallCount: 10 * scale.skills,
      toolFailureRate: 0.1,
      timeRange: { from: timestampAt(index), to: timestampAt(index) },
      generatedAt,
    },
    overall: { gapRate: 0, weightedGapRate: 0, healthBand: 'green' },
    bySkill,
  };
}

/** doctor 报告形状与 test/studio/application/skill-index-cache.test.ts 的夹具一致。 */
export function buildDoctorReport(scale: BaselineScale, index: number): unknown {
  const slice = 20;
  const skills = [];
  for (let offset = 0; offset < Math.min(slice, scale.skills); offset += 1) {
    const skillName = skillNameAt(scale, index * slice + offset);
    skills.push({
      skillName,
      skillPath: join('baseline', skillName),
      status: 'pass',
      results: [{ ruleId: 'baseline', severity: 'info', labelKey: 'baseline', status: 'pass', message: 'ok', durationMs: 0 }],
    });
  }
  const timestamp = timestampAt(index);
  return {
    kind: 'doctor',
    schemaVersion: '3.0.0',
    id: `baseline-doctor-${index}`,
    timestamp,
    cliVersion: 'baseline',
    cwd: 'baseline',
    executorName: 'script',
    model: 'baseline',
    outcome: 'passed',
    // parseDoctorReport 强校验：totals 必须等于各 skill 状态计数，
    // ruleStats 必须等于全部 rule 结果计数，否则整份报告被静默丢弃。
    totals: { pass: skills.length, warn: 0, fail: 0 },
    ruleStats: { pass: skills.length, warn: 0, fail: 0, skipped: 0, total: skills.length },
    skills,
  };
}

/** 最新 inbox 报告：itemCount === items.length，条目满足回读一致性校验。 */
export function buildInboxReport(scale: BaselineScale, itemCount: number, generatedAt: string): unknown {
  const items = [];
  for (let index = 0; index < itemCount; index += 1) {
    const sessionId = `baseline-session-${index % 10}`;
    const evidence = { tool: 'Grep', query: `baseline-query-${index}` };
    items.push({
      id: `baseline-item-${index}`,
      skillName: skillNameAt(scale, index),
      artifactVersion: 'unknown',
      sessionId,
      sourceTrace: join('baseline', 'trace.jsonl'),
      sourceKind: 'codex',
      signalType: 'failed_search',
      signalSubtype: 'hard_miss',
      confidence: 0.9,
      attributionConfidence: 0.9,
      severity: 'high',
      evidence,
      firstSeen: timestampAt(index),
      lastSeen: timestampAt(index),
      occurrences: 1,
      recentSessionIds: [sessionId],
      representativeEvidence: [{ ...evidence }],
    });
  }
  return {
    kind: 'observe-inbox',
    schemaVersion: 2,
    meta: {
      tracePath: join('baseline', 'trace.jsonl'),
      generatedAt,
      segmentCount: itemCount,
      itemCount,
    },
    items,
  };
}

/** dist 运行期依赖注入：脚本主体经动态 import 取 dist，测试注入 src 实现。 */
export interface BaselineDatasetWriters {
  readonly writeMeasurementReportBundle: (input: {
    readonly rootDir: string;
    readonly measurementDomain: 'doctor' | 'observe-health';
    readonly recordId: string;
    readonly reportId: string;
    readonly createdAt: string;
    readonly report: unknown;
  }) => unknown;
  readonly saveObservationInboxReport: (report: unknown, outDir: string) => string;
}

export interface BaselineDatasetLayout {
  readonly root: string;
  readonly analysesDir: string;
  readonly doctorsDir: string;
  readonly observationsDir: string;
  /** 最新一份 observe-health 的 recordId（详情路由参数）。 */
  readonly latestAnalysisId: string;
  readonly firstSkillName: string;
}

export function writeBaselineDataset(
  scale: BaselineScale,
  writers: BaselineDatasetWriters,
  root: string = mkdtempSync(join(tmpdir(), `omk-baseline-${scale.name}-`)),
): BaselineDatasetLayout {
  const analysesDir = join(root, 'analyses');
  const doctorsDir = join(root, 'doctors');
  const observationsDir = join(root, 'observations');
  let latestAnalysisId = '';
  for (let index = 0; index < scale.analyses; index += 1) {
    const recordId = `obs-${String(index).padStart(4, '0')}`;
    writers.writeMeasurementReportBundle({
      rootDir: analysesDir,
      measurementDomain: 'observe-health',
      recordId,
      reportId: `baseline-observe-${index}`,
      createdAt: timestampAt(index),
      report: buildObserveHealthReport(scale, index),
    });
    latestAnalysisId = recordId;
  }
  for (let index = 0; index < scale.doctorReports; index += 1) {
    writers.writeMeasurementReportBundle({
      rootDir: doctorsDir,
      measurementDomain: 'doctor',
      recordId: `doc-${String(index).padStart(4, '0')}`,
      reportId: `baseline-doctor-${index}`,
      createdAt: timestampAt(index),
      report: buildDoctorReport(scale, index),
    });
  }
  // 旧报告各 1 条（目录扫描成本），最新报告承载 inboxItems 条（聚合成本）。
  for (let index = 0; index < scale.inboxReports - 1; index += 1) {
    writers.saveObservationInboxReport(
      buildInboxReport(scale, 1, timestampAt(10_000 + index)),
      observationsDir,
    );
  }
  writers.saveObservationInboxReport(
    buildInboxReport(scale, scale.inboxItems, timestampAt(20_000)),
    observationsDir,
  );
  return {
    root,
    analysesDir,
    doctorsDir,
    observationsDir,
    latestAnalysisId,
    firstSkillName: skillNameAt(scale, 0),
  };
}

interface RouteMeasurement {
  readonly route: string;
  readonly coldMs: number | undefined;
  readonly warmMs: number;
  readonly bytes: number;
}

export interface ScaleResult {
  readonly scale: BaselineScale;
  readonly routes: RouteMeasurement[];
  readonly concurrency: {
    readonly requests: number;
    readonly wallMs: number;
    readonly eventLoopP99Ms: number;
  };
  readonly coldEventLoopP99Ms: number;
}

interface ReportServerLike {
  start(): Promise<string>;
  stop(): Promise<void>;
}

interface DistModules {
  readonly createReportServer: (options: {
    readonly port: number;
    readonly analysesDir: string;
    readonly doctorsDir: string;
    readonly observationsDir: string;
  }) => ReportServerLike;
  readonly writers: BaselineDatasetWriters;
}

async function loadDist(): Promise<DistModules> {
  const importDist = (path: string) => import(pathToFileURL(resolve(REPO_ROOT, path)).href);
  const reportServer = await importDist('dist/studio/http/report-server.js') as {
    createReportServer: DistModules['createReportServer'];
  };
  const bundle = await importDist('dist/evidence/storage/report-bundle.js') as {
    writeMeasurementReportBundle: BaselineDatasetWriters['writeMeasurementReportBundle'];
  };
  const inbox = await importDist('dist/observability/inbox/index.js') as {
    saveObservationInboxReport: BaselineDatasetWriters['saveObservationInboxReport'];
  };
  return {
    createReportServer: reportServer.createReportServer,
    writers: {
      writeMeasurementReportBundle: bundle.writeMeasurementReportBundle,
      saveObservationInboxReport: inbox.saveObservationInboxReport,
    },
  };
}

const WARM_REPEATS = 5;
const CONCURRENCY = 24;

async function measureRoute(url: string): Promise<{ ms: number; bytes: number }> {
  const start = performance.now();
  const response = await fetch(url);
  const body = await response.arrayBuffer();
  if (!response.ok) throw new Error(`baseline route ${url} returned ${response.status}`);
  return { ms: performance.now() - start, bytes: body.byteLength };
}

async function measureScale(scale: BaselineScale, dist: DistModules): Promise<ScaleResult> {
  const dataset = writeBaselineDataset(scale, dist.writers);
  const server = dist.createReportServer({
    port: 0,
    analysesDir: dataset.analysesDir,
    doctorsDir: dataset.doctorsDir,
    observationsDir: dataset.observationsDir,
  });
  try {
    const baseUrl = await server.start();
    const routes: RouteMeasurement[] = [];
    // /api/skills 承担 skill 索引冷构建：单独测冷 + 事件循环阻塞，后续路由全部走热缓存。
    const coldMonitor = monitorEventLoopDelay();
    coldMonitor.enable();
    const cold = await measureRoute(`${baseUrl}/api/skills`);
    const coldEventLoopP99Ms = coldMonitor.percentile(99) / 1e6;
    coldMonitor.disable();
    const warmSkills: number[] = [];
    for (let repeat = 0; repeat < WARM_REPEATS; repeat += 1) {
      warmSkills.push((await measureRoute(`${baseUrl}/api/skills`)).ms);
    }
    routes.push({
      route: 'GET /api/skills',
      coldMs: cold.ms,
      warmMs: Math.min(...warmSkills),
      bytes: cold.bytes,
    });

    const warmOnly: readonly string[] = [
      'GET /api/observe-health',
      'GET /observe/health',
      `GET /observe/health/${dataset.latestAnalysisId}`,
      `GET /observe/skill-trend/${encodeURIComponent(dataset.firstSkillName)}`,
      'GET /api/observe-inbox',
      // /observe/inbox 与 /knowledge 页面已由 Next 宿主渲染；本脚本测的是独立 HTML 宿主，那里按设计 404。
    ];
    for (const route of warmOnly) {
      const path = route.slice('GET '.length);
      const samples: number[] = [];
      let bytes = 0;
      for (let repeat = 0; repeat < WARM_REPEATS; repeat += 1) {
        const sample = await measureRoute(`${baseUrl}${path}`);
        samples.push(sample.ms);
        bytes = sample.bytes;
      }
      routes.push({ route, coldMs: undefined, warmMs: Math.min(...samples), bytes });
    }

    const monitor = monitorEventLoopDelay();
    monitor.enable();
    const concurrentStart = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => measureRoute(`${baseUrl}/observe/health`)),
    );
    const wallMs = performance.now() - concurrentStart;
    const eventLoopP99Ms = monitor.percentile(99) / 1e6;
    monitor.disable();

    return {
      scale,
      routes,
      concurrency: { requests: CONCURRENCY, wallMs, eventLoopP99Ms },
      coldEventLoopP99Ms,
    };
  } finally {
    await server.stop();
    rmSync(dataset.root, { recursive: true, force: true });
  }
}

function formatMs(value: number | undefined): string {
  return value === undefined ? '—' : value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(2)} MB`
    : `${(value / 1024).toFixed(1)} KB`;
}

export function renderBaselineMarkdown(results: readonly ScaleResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const { scale } = result;
    lines.push(
      `### ${scale.name}（skills=${scale.skills}，analyses=${scale.analyses}，doctor=${scale.doctorReports}，inbox=${scale.inboxItems} 条/${scale.inboxReports} 份）`,
      '',
      '| 路由 | 冷 (ms) | 热 (ms，5 次取最小) | 响应体积 |',
      '| --- | ---: | ---: | ---: |',
    );
    for (const route of result.routes) {
      lines.push(`| \`${route.route}\` | ${formatMs(route.coldMs)} | ${formatMs(route.warmMs)} | ${formatBytes(route.bytes)} |`);
    }
    lines.push(
      '',
      `冷 /api/skills 期间事件循环 p99 延迟：${formatMs(result.coldEventLoopP99Ms)} ms；`,
      `${result.concurrency.requests} 并发 GET /observe/health（热）：墙钟 ${formatMs(result.concurrency.wallMs)} ms，事件循环 p99 ${formatMs(result.concurrency.eventLoopP99Ms)} ms。`,
      '',
    );
  }
  return lines.join('\n');
}

export async function runBaseline(): Promise<ScaleResult[]> {
  const dist = await loadDist();
  const results: ScaleResult[] = [];
  for (const scale of BASELINE_SCALES) {
    results.push(await measureScale(scale, dist));
  }
  return results;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  runBaseline()
    .then((results) => {
      console.log(renderBaselineMarkdown(results));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
