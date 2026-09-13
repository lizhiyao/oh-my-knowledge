import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  BASELINE_SCALES,
  buildDoctorReport,
  buildInboxReport,
  buildObserveHealthReport,
  renderBaselineMarkdown,
  writeBaselineDataset,
  type BaselineDatasetWriters,
  type ScaleResult,
} from '../../scripts/studio-baseline.js';
import { writeMeasurementReportBundle } from '../../src/evidence/storage/report-bundle.js';
import { parseDoctorReport } from '../../src/knowledge-artifacts/doctor/report-parser.js';
import {
  loadObservationInboxReports,
  saveObservationInboxReport,
  type ObservationInboxReport,
} from '../../src/observability/inbox/index.js';
import { parseSkillHealthReport } from '../../src/observability/skill-health/report.js';
import { buildSkillIndex } from '../../src/studio/application/skill-index.js';

const writers: BaselineDatasetWriters = {
  writeMeasurementReportBundle,
  saveObservationInboxReport: (report, outDir) =>
    saveObservationInboxReport(report as ObservationInboxReport, outDir),
};

const tempRoots: string[] = [];
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'omk-baseline-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('studio-baseline 规模定义', () => {
  it('三档规模命名固定且数据量递增', () => {
    assert.deepEqual(BASELINE_SCALES.map((scale) => scale.name), ['small', 'medium', 'large']);
    for (let index = 1; index < BASELINE_SCALES.length; index += 1) {
      const previous = BASELINE_SCALES[index - 1]!;
      const current = BASELINE_SCALES[index]!;
      assert.ok(current.skills > previous.skills);
      assert.ok(current.analyses > previous.analyses);
      assert.ok(current.inboxItems > previous.inboxItems);
      assert.ok(current.inboxReports > previous.inboxReports);
    }
  });
});

describe('studio-baseline 夹具有效性', () => {
  it('observe-health 夹具通过 parseSkillHealthReport 严格一致性校验', () => {
    for (const scale of BASELINE_SCALES) {
      const parsed = parseSkillHealthReport(buildObserveHealthReport(scale, 0));
      assert.ok(parsed, `${scale.name} 档 observe-health 夹具必须被解析器接受`);
      assert.equal(Object.keys(parsed.bySkill).length, scale.skills);
      assert.equal(parsed.meta.segmentCount, 4 * scale.skills);
    }
  });

  it('doctor 夹具通过 parseDoctorReport 一致性校验', () => {
    for (const scale of BASELINE_SCALES) {
      const parsed = parseDoctorReport(buildDoctorReport(scale, 0));
      assert.ok(parsed, `${scale.name} 档 doctor 夹具必须被解析器接受`);
      const skillCount = Math.min(20, scale.skills);
      assert.equal(parsed.skills.length, skillCount);
      assert.equal(parsed.totals.pass, skillCount);
      assert.equal(parsed.ruleStats.total, skillCount);
    }
  });

  it('inbox 夹具可写入并被 loadObservationInboxReports 回读', () => {
    const root = makeTempRoot();
    const observationsDir = join(root, 'observations');
    const report = buildInboxReport(BASELINE_SCALES[0], 7, new Date().toISOString());
    saveObservationInboxReport(report as ObservationInboxReport, observationsDir);

    const loaded = loadObservationInboxReports(observationsDir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.items.length, 7);
  });

  it('writeBaselineDataset 产出的数据集可被 buildSkillIndex 全量索引', () => {
    const scale = BASELINE_SCALES[0]!;
    const layout = writeBaselineDataset(scale, writers, makeTempRoot());
    assert.equal(layout.latestAnalysisId, `obs-${String(scale.analyses - 1).padStart(4, '0')}`);
    assert.equal(layout.firstSkillName, 'baseline-skill-000');

    const index = buildSkillIndex(layout.analysesDir, layout.doctorsDir, layout.observationsDir);
    assert.equal(index.summary.totalSkills, scale.skills);
    assert.equal(index.summary.withObserve, scale.skills);
    assert.equal(index.summary.withDoctor, scale.skills);
    assert.equal(index.entries.length, scale.skills);

    const inboxReports = loadObservationInboxReports(layout.observationsDir);
    assert.equal(inboxReports.length, scale.inboxReports);
  });
});

describe('studio-baseline 输出', () => {
  it('renderBaselineMarkdown 按规模输出冷/热/体积表格与事件循环行', () => {
    const result: ScaleResult = {
      scale: BASELINE_SCALES[0]!,
      routes: [
        { route: 'GET /api/skills', coldMs: 12.34, warmMs: 4.56, bytes: 2048 },
        { route: 'GET /observe/inbox', coldMs: undefined, warmMs: 150.2, bytes: 3 * 1024 * 1024 },
      ],
      concurrency: { requests: 24, wallMs: 88.8, eventLoopP99Ms: 6.2 },
      coldEventLoopP99Ms: 9.9,
    };

    const markdown = renderBaselineMarkdown([result]);
    assert.ok(markdown.includes('### small（skills=5，analyses=10，doctor=5，inbox=20 条/2 份）'));
    assert.ok(markdown.includes('| 路由 | 冷 (ms) | 热 (ms，5 次取最小) | 响应体积 |'));
    assert.ok(markdown.includes('| `GET /api/skills` | 12.3 | 4.6 | 2.0 KB |'));
    assert.ok(markdown.includes('| `GET /observe/inbox` | — | 150 | 3.00 MB |'));
    assert.ok(markdown.includes('冷 /api/skills 期间事件循环 p99 延迟：9.9 ms'));
    assert.ok(markdown.includes('24 并发 GET /observe/health（热）：墙钟 88.8 ms，事件循环 p99 6.2 ms。'));
  });
});
