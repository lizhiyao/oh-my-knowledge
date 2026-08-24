import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import {
  extractRun,
  loadPerCpu,
  median,
  parseProfileArgs,
  summarizeProfile,
  type ProfileRun,
} from '../../scripts/test-profile.js';

function run(index: number, wallTimeMs: number, files: Array<[string, number, number]>): ProfileRun {
  return {
    index,
    wallTimeMs,
    loadAverageBefore: [1, 1, 1],
    loadAverageAfter: [1, 1, 1],
    reportFile: `.omk/run-${index}.json`,
    fileCount: files.length,
    testCount: files.length,
    passedTests: files.length,
    failedTests: 0,
    pendingTests: 0,
    aggregateTestTimeMs: files.reduce((sum, file) => sum + file[2], 0),
    slowFiles: files.map(([file, durationMs, testTimeMs]) => ({ file, durationMs, testTimeMs })),
  };
}

describe('test-profile', () => {
  it('解析默认值与显式覆盖', () => {
    assert.deepEqual(parseProfileArgs([]), {
      runs: 3,
      warmup: 1,
      top: 15,
      maxWorkers: '55%',
      help: false,
    });
    assert.deepEqual(
      parseProfileArgs(['--runs', '5', '--warmup', '0', '--top', '8', '--max-workers', '4', '--output', '/tmp/profile']),
      { runs: 5, warmup: 0, top: 8, maxWorkers: '4', outputDir: '/tmp/profile', help: false },
    );
  });

  it('拒绝无效轮数、worker 和未知参数', () => {
    assert.throws(() => parseProfileArgs(['--runs', '0']), /--runs/);
    assert.throws(() => parseProfileArgs(['--max-workers', '0%']), /--max-workers/);
    assert.throws(() => parseProfileArgs(['--wat']), /未知参数/);
  });

  it('计算奇偶样本中位数', () => {
    assert.equal(median([9, 1, 5]), 5);
    assert.equal(median([10, 2, 6, 4]), 5);
    assert.equal(loadPerCpu([22, 10, 5], 11), 2);
    assert.throws(() => loadPerCpu([1, 1, 1], 0), /parallelism/);
  });

  it('从 Vitest JSON 提取文件与用例耗时', () => {
    const result = extractRun({
      success: true,
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [{
        name: `${process.cwd()}/test/example.test.ts`,
        startTime: 100,
        endTime: 125.5,
        assertionResults: [{ duration: 10 }, { duration: 5.5 }],
      }],
    }, 1, 40, `${process.cwd()}/.omk/run-1.json`, [1, 2, 3], [2, 3, 4]);
    assert.equal(result.fileCount, 1);
    assert.equal(result.aggregateTestTimeMs, 15.5);
    assert.deepEqual(result.slowFiles[0], {
      file: 'test/example.test.ts',
      durationMs: 25.5,
      testTimeMs: 15.5,
    });
  });

  it('按多轮中位数汇总波动和慢文件', () => {
    const summary = summarizeProfile([
      run(1, 10_000, [['a.test.ts', 3_000, 2_000], ['b.test.ts', 5_000, 4_000]]),
      run(2, 20_000, [['a.test.ts', 7_000, 6_000], ['b.test.ts', 4_000, 3_000]]),
      run(3, 30_000, [['a.test.ts', 5_000, 4_000], ['b.test.ts', 6_000, 5_000]]),
    ], 1);
    assert.deepEqual(summary.wallTimeMs, {
      min: 10_000,
      median: 20_000,
      max: 30_000,
      range: 20_000,
      mean: 20_000,
      coefficientOfVariation: 0.408,
    });
    assert.deepEqual(summary.slowFiles, [{
      file: 'a.test.ts',
      medianDurationMs: 5_000,
      medianTestTimeMs: 4_000,
      durationsMs: [3_000, 7_000, 5_000],
    }]);
  });

  it('受控 CI profile 固定 runner，且只按需运行并上传原始报告', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/test-profile.yml'), 'utf8');
    assert.ok(workflow.includes('workflow_dispatch:'));
    assert.ok(workflow.includes("contains(github.event.pull_request.labels.*.name, 'test-profile')"));
    assert.ok(workflow.includes('runs-on: ubuntu-24.04'));
    assert.ok(workflow.includes('yarn test:profile'));
    assert.ok(workflow.includes('uses: actions/upload-artifact@v7'));
    assert.ok(workflow.includes('path: .omk/test-profiles/ci/'));
  });
});
