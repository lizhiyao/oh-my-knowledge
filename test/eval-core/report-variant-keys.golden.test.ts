/**
 * GOLDEN — 端到端钉住 variant 报告键。
 *
 * variant 命名链路(expr → artifact.name → 报告键)是测量学不变量:artifact.name 同时
 * 是 meta.variants / summary / results[].variants / artifactHashes / skillIsolation /
 * executorRuntimes / pairComparisons.control|treatment 的键。这条链路在
 * skill-loader 里有多处独立派生,历史上反复发散。本测试走真实解析路径
 * (prepareEvaluationRun dryRun → aggregateReport),把这组键钉死,作为后续「行为保持」
 * 重构的护栏:快照只要 byte-identical,就证明重构没动跨版本可比性。
 *
 * runId 不在快照投影里(它由 new Date() 派生、含时间戳);其变量名编码部分另由文末的
 * generateRunId 单测用 regex 单独覆盖,而非靠本快照。
 *
 * 覆盖范围:只覆盖 eval 主路径(prepareEvaluationRun 的 !artifacts 分支,按 index 绑定)。
 * batch 路径(外部预置 artifacts 走 else 分支按 name 匹配)不在本 golden 内,见
 * batch-evaluation-workflow 的独立测试 / 跟进 issue。
 *
 * 投影(projectVariantSurfaces)只保留 variant 相关的键面,丢掉 timestamp / cliVersion /
 * executorRuntimes 的值(含本机 PATH/工具版本,非确定)等噪声,避免无关变动误伤命名 golden。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEvaluationRun } from '../../src/eval-workflows/evaluation-preparation.js';
import { aggregateReport, applyBlindMode, generateRunId } from '../../src/eval-core/evaluation-reporting.js';
import type { Report, VariantResult, VariantSpec, EvaluationRequest } from '../../src/types/index.js';

function makeVariantResult(compositeScore?: number): VariantResult {
  return {
    ok: true,
    durationMs: 100, durationApiMs: 100,
    inputTokens: 100, outputTokens: 50, totalTokens: 150,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    execCostUSD: 0.001, judgeCostUSD: 0, costUSD: 0.001,
    numTurns: 1, outputPreview: 'ok',
    ...(compositeScore !== undefined ? { compositeScore } : {}),
  };
}

/** 照 evaluation-execution.ts 的 results[sample][task.variant] 形状拼造确定性结果。
 *  每个 sample × variant 一个 entry;compositeScore 让 bootstrap / pairComparisons 能产出。 */
function buildResults(
  sampleIds: string[],
  variantNames: string[],
  scored: boolean,
): Record<string, Record<string, VariantResult>> {
  const results: Record<string, Record<string, VariantResult>> = {};
  for (const sid of sampleIds) {
    results[sid] = {};
    variantNames.forEach((v, vi) => {
      // 给不同 variant 不同分,且每 variant 跨 sample ≥2 个正分,满足 bootstrap 阈值
      results[sid][v] = makeVariantResult(scored ? 0.5 + vi * 0.1 : undefined);
    });
  }
  return results;
}

/** variant 相关键面的确定性投影。命名链路一旦发散,这些就对不上。 */
function projectVariantSurfaces(report: Report) {
  const meta = report.meta;
  const variantConfigs = meta.variantConfigs ?? [];
  return {
    metaVariants: meta.variants,
    summaryKeys: Object.keys(report.summary).sort(),
    artifactHashKeys: Object.keys(meta.artifactHashes ?? {}).sort(),
    skillIsolation: meta.skillIsolation, // name → allowedSkills | null(确定,命名+构念相关)
    executorRuntimeKeys: Object.keys(meta.executorRuntimes ?? {}).sort(),
    resultVariantKeys: report.results.map((r) => ({
      sample_id: r.sample_id,
      variants: Object.keys(r.variants).sort(),
    })),
    roleByVariant: Object.fromEntries(
      meta.variants.map((v, i) => [v, variantConfigs[i]?.experimentRole ?? null]),
    ),
    pairComparisons: (meta.pairComparisons ?? []).map((p) => ({ control: p.control, treatment: p.treatment })),
  };
}

/** 头号不变量:所有 variant 键面共享同一组键。碎片化恰恰让它们发散,这一条价值最高。 */
function assertAllVariantSurfacesEqual(report: Report, variantNames: string[]): void {
  const expected = [...variantNames].sort();
  const meta = report.meta;
  assert.deepEqual([...meta.variants].sort(), expected, 'meta.variants');
  assert.deepEqual(Object.keys(report.summary).sort(), expected, 'summary keys');
  assert.deepEqual(Object.keys(meta.artifactHashes ?? {}).sort(), expected, 'artifactHashes keys');
  assert.deepEqual(Object.keys(meta.skillIsolation ?? {}).sort(), expected, 'skillIsolation keys');
  assert.deepEqual(Object.keys(meta.executorRuntimes ?? {}).sort(), expected, 'executorRuntimes keys');
  for (const r of report.results) {
    assert.deepEqual(Object.keys(r.variants).sort(), expected, `results[${r.sample_id}].variants keys`);
  }
}

interface RunCaseOpts {
  variantSpecs: VariantSpec[];
  request?: EvaluationRequest;
  scored?: boolean;
}

let root: string;
let samplesPath: string;

/** 真实解析 + 聚合:prepareEvaluationRun(dryRun) → 确定性 results → aggregateReport。 */
async function runCase(opts: RunCaseOpts): Promise<{ report: Report; variantNames: string[] }> {
  const prepared = await prepareEvaluationRun({
    samplesPath,
    skillDir: root,
    variantSpecs: opts.variantSpecs,
    dryRun: true,
  });
  const sampleIds = prepared.samples.map((s) => s.sample_id);
  const results = buildResults(sampleIds, prepared.variantNames, opts.scored ?? false);
  const report = aggregateReport({
    runId: 'golden-run',
    variants: prepared.variantNames,
    model: 'mock-model',
    judgeModel: 'mock-judge',
    noJudge: true,
    executorName: 'mock-exec',
    samples: prepared.samples,
    tasks: prepared.tasks,
    results,
    totalCostUSD: 0,
    artifacts: prepared.artifacts,
    request: opts.request,
  });
  return { report, variantNames: prepared.variantNames };
}

const ctrl = (expr: string, name = 'x'): VariantSpec => ({ name, role: 'control', expr });
const treat = (expr: string, name = 'x'): VariantSpec => ({ name, role: 'treatment', expr });

describe('GOLDEN report variant keys', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-golden-'));
    // v1/v2 同 basename 分目录,顶层 greeter.md / helper.md / a.md / b.md
    for (const v of ['v1', 'v2']) {
      mkdirSync(join(root, v), { recursive: true });
      writeFileSync(join(root, v, 'greeter.md'), `# greeter ${v}\n`);
    }
    writeFileSync(join(root, 'greeter.md'), '# greeter top\n');
    writeFileSync(join(root, 'helper.md'), '# helper top\n');
    writeFileSync(join(root, 'a.md'), '# skill a\n');
    writeFileSync(join(root, 'b.md'), '# skill b\n');
    samplesPath = join(root, 'samples.json');
    writeFileSync(samplesPath, JSON.stringify([
      { sample_id: 's1', prompt: '你好' },
      { sample_id: 's2', prompt: '世界' },
    ]));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('case 1 — baseline vs single skill: isolation [] vs null, roles', async () => {
    const { report, variantNames } = await runCase({
      variantSpecs: [ctrl('baseline', 'baseline'), treat(join(root, 'greeter.md'), 'greeter')],
    });
    assert.deepEqual(variantNames, ['baseline', 'greeter']);
    assertAllVariantSurfacesEqual(report, variantNames);
    assert.deepEqual(report.meta.skillIsolation, { baseline: [], greeter: null });
    assert.deepEqual(projectVariantSurfaces(report).roleByVariant, { baseline: 'control', greeter: 'treatment' });
    expect(projectVariantSurfaces(report)).toMatchSnapshot();
  });

  it('case 2 — same-basename diff dirs flow disambiguated names to every surface', async () => {
    const { report, variantNames } = await runCase({
      variantSpecs: [ctrl(join(root, 'v1', 'greeter.md')), treat(join(root, 'v2', 'greeter.md'))],
    });
    assert.deepEqual(variantNames, ['v1/greeter', 'v2/greeter']);
    assertAllVariantSurfacesEqual(report, variantNames);
    expect(projectVariantSurfaces(report)).toMatchSnapshot();
  });

  it('case 3 — eval.yaml custom name + allowedSkills:[] lands on disambiguated artifact', async () => {
    const { report, variantNames } = await runCase({
      variantSpecs: [
        { name: 'control-v1', role: 'control', expr: join(root, 'v1', 'greeter.md'), allowedSkills: [] },
        { name: 'treat-v2', role: 'treatment', expr: join(root, 'v2', 'greeter.md') },
      ],
    });
    assert.deepEqual(variantNames, ['v1/greeter', 'v2/greeter']);
    assertAllVariantSurfacesEqual(report, variantNames);
    // 自定义名声明的 allowedSkills:[] 必须落到消歧后的 artifact 名上(隔离生效,不是 undefined→null)
    assert.deepEqual(report.meta.skillIsolation, { 'v1/greeter': [], 'v2/greeter': null });
    expect(projectVariantSurfaces(report)).toMatchSnapshot();
  });

  it('case 4 — multi-treatment + bootstrap: pairComparisons by name, 3 distinct keys', async () => {
    const { report, variantNames } = await runCase({
      variantSpecs: [ctrl('baseline', 'baseline'), treat(join(root, 'a.md'), 'a'), treat(join(root, 'b.md'), 'b')],
      request: { bootstrap: true, bootstrapSamples: 50 } as EvaluationRequest,
      scored: true,
    });
    assert.deepEqual(variantNames, ['baseline', 'a', 'b']);
    assertAllVariantSurfacesEqual(report, variantNames);
    assert.deepEqual(
      report.meta.pairComparisons?.map((p) => ({ control: p.control, treatment: p.treatment })),
      [{ control: 'baseline', treatment: 'a' }, { control: 'baseline', treatment: 'b' }],
    );
    expect(projectVariantSurfaces(report)).toMatchSnapshot();
  });

  it('case 5 — git variant passes through opaquely to all keys', async () => {
    // 临时 git 仓库,提交 greeter.md。resolveArtifacts 的 git 解析(getGitRelativePath /
    // gitShowFile)走进程 cwd,且 git toplevel 在 macOS 下是 realpath(/private/...),所以
    // chdir 进 realpath 化的仓库根、skillDir 也传 realpath,relative 才为空、能命中 HEAD:greeter.md。
    // 注:这里用 process.chdir(进程级全局态)。依赖 vitest 文件级进程隔离(默认 fileParallelism
    // 下每文件独立 worker、同文件内 test 串行)+ 下方 finally 还原 cwd;若改并发/线程池需重新评估。
    const gitRoot = realpathSync(mkdtempSync(join(tmpdir(), 'omk-golden-git-')));
    const sh = (args: string[]): void => { execFileSync('git', args, { cwd: gitRoot, stdio: 'ignore' }); };
    const prevCwd = process.cwd();
    try {
      sh(['init']);
      sh(['config', 'user.email', 'golden@example.com']);
      sh(['config', 'user.name', 'golden']);
      writeFileSync(join(gitRoot, 'greeter.md'), '# git greeter\n');
      writeFileSync(join(gitRoot, 'samples.json'), JSON.stringify([{ sample_id: 's1', prompt: 'p' }, { sample_id: 's2', prompt: 'q' }]));
      sh(['add', '.']);
      sh(['commit', '-m', 'seed']);
      process.chdir(gitRoot);
      const prepared = await prepareEvaluationRun({
        samplesPath: join(gitRoot, 'samples.json'),
        skillDir: gitRoot,
        variantSpecs: [ctrl('baseline', 'baseline'), treat('git:HEAD:greeter', 'greeter')],
        dryRun: true,
      });
      assert.deepEqual(prepared.variantNames, ['baseline', 'git:HEAD:greeter']);
      const results = buildResults(prepared.samples.map((s) => s.sample_id), prepared.variantNames, false);
      const report = aggregateReport({
        runId: 'golden-run', variants: prepared.variantNames, model: 'mock-model', judgeModel: 'mock-judge',
        noJudge: true, executorName: 'mock-exec', samples: prepared.samples, tasks: prepared.tasks,
        results, totalCostUSD: 0, artifacts: prepared.artifacts,
      });
      assertAllVariantSurfacesEqual(report, prepared.variantNames);
      assert.ok('git:HEAD:greeter' in report.meta.skillIsolation!, 'git variant name is a report key verbatim');
      expect(projectVariantSurfaces(report)).toMatchSnapshot();
    } finally {
      process.chdir(prevCwd);
      rmSync(gitRoot, { recursive: true, force: true });
    }
  });

  it('case 6 — custom names with no collision are replaced by derived short names', async () => {
    const { report, variantNames } = await runCase({
      variantSpecs: [
        { name: 'my-control', role: 'control', expr: join(root, 'greeter.md') },
        { name: 'my-treat', role: 'treatment', expr: join(root, 'helper.md') },
      ],
    });
    // spec.name 被派生短名替换,而非保留自定义名 —— 钉住这一行为,重构不能悄悄改
    assert.deepEqual(variantNames, ['greeter', 'helper']);
    assertAllVariantSurfacesEqual(report, variantNames);
    expect(projectVariantSurfaces(report)).toMatchSnapshot();
  });

  it('case 7 — blind mode remaps every variant surface to A/B/C and round-trips', async () => {
    const prepared = await prepareEvaluationRun({
      samplesPath, skillDir: root, dryRun: true,
      variantSpecs: [ctrl('baseline', 'baseline'), treat(join(root, 'a.md'), 'a'), treat(join(root, 'b.md'), 'b')],
    });
    const sampleIds = prepared.samples.map((s) => s.sample_id);
    const results = buildResults(sampleIds, prepared.variantNames, false);
    const report = aggregateReport({
      runId: 'golden-run', variants: prepared.variantNames, model: 'mock-model', judgeModel: 'mock-judge',
      noJudge: true, executorName: 'mock-exec', samples: prepared.samples, tasks: prepared.tasks,
      results, totalCostUSD: 0, artifacts: prepared.artifacts,
    });
    applyBlindMode(report, prepared.variantNames, 'fixed-seed');
    // 当前行为(被钉住):blind 只 remap variants / summary / results / executorRuntimes 到 A/B/C,
    // 不动 artifactHashes / skillIsolation(仍是原始名)。这层不对称是既有事实,重构不能悄悄改;
    // 若日后要让 blind 也覆盖这两个键面(防泄露),属于行为变更,得显式改这条断言。
    assert.deepEqual(report.meta.variants, ['A', 'B', 'C']);
    assert.deepEqual(Object.keys(report.summary).sort(), ['A', 'B', 'C']);
    assert.deepEqual(Object.keys(report.meta.executorRuntimes ?? {}).sort(), ['A', 'B', 'C']);
    for (const r of report.results) {
      assert.deepEqual(Object.keys(r.variants).sort(), ['A', 'B', 'C'], `results[${r.sample_id}]`);
    }
    assert.deepEqual(Object.keys(report.meta.artifactHashes ?? {}).sort(), ['a', 'b', 'baseline'], 'artifactHashes NOT remapped');
    assert.deepEqual(Object.keys(report.meta.skillIsolation ?? {}).sort(), ['a', 'b', 'baseline'], 'skillIsolation NOT remapped');
    // blindMap 是 bijection(标签集 ↔ 原始 variant 集,无丢无重)
    const blindMap = report.meta.blindMap ?? {};
    assert.deepEqual(Object.keys(blindMap).sort(), ['A', 'B', 'C'], 'blindMap labels');
    assert.deepEqual(Object.values(blindMap).slice().sort(), ['a', 'b', 'baseline'], 'blindMap originals');
    // 固定 seed → 映射确定,快照钉住具体的 label→原名(升级「往返不丢」为「映射正确」:
    // 哪怕集合不变、A/B/C 各映到错的 variant,本快照也会抓到)。
    expect(blindMap).toMatchSnapshot();
    // 反向映射:summary 在 blind 后的某个 label,其对应原名确实来自 blindMap(往返自洽)
    for (const label of Object.keys(report.summary)) {
      assert.ok(label in blindMap, `summary label ${label} has a blindMap entry`);
    }
  });

  it('generateRunId encodes variant names in order, sanitized', () => {
    // 格式:<variants>-<YYYYMMDD>-<HHmmss>-<rand4>。秒 + 4 位随机后缀保证跨项目 / 同分钟重跑全局唯一。
    assert.match(generateRunId(['baseline', 'greeter']), /^baseline-vs-greeter-\d{8}-\d{6}-[a-z0-9]{4}$/);
    assert.match(generateRunId(['v1/greeter', 'v2/greeter']), /^v1-greeter-vs-v2-greeter-\d{8}-\d{6}-[a-z0-9]{4}$/);
    assert.match(generateRunId(['git:HEAD:greeter']), /^git-HEAD-greeter-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  it('generateRunId 同时刻两次产出不同 id(撞名根治)', () => {
    const a = generateRunId(['baseline', 'greeter']);
    const b = generateRunId(['baseline', 'greeter']);
    assert.notEqual(a, b, '随机后缀应让同一时刻两次 run 的 id 不同');
  });
});
