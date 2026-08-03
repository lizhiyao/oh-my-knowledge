import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateReport } from '../../src/eval-core/evaluation-reporting.js';
import { parseReportDocument } from '../../src/eval-core/report-document.js';
import type { Artifact, Sample, Task, VariantResult, EvaluationRequest } from '../../src/types/index.js';

function makeArtifact(name: string, content: string): Artifact {
  return { name, kind: 'skill', source: 'inline', content, experimentRole: 'treatment' };
}

function makeSample(id: string, prompt: string, rubric?: string): Sample {
  const s: Sample = { sample_id: id, prompt };
  if (rubric) s.rubric = rubric;
  return s;
}

function makeVariantResult(): VariantResult {
  return {
    ok: true,
    durationMs: 100, durationApiMs: 100,
    inputTokens: 100, outputTokens: 50, totalTokens: 150,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    execCostUSD: 0.001, judgeCostUSD: 0, costUSD: 0.001,
    numTurns: 1, outputPreview: 'ok',
  };
}

function makeTask(variant: string, artifact: Artifact, sample: Sample): Task {
  return {
    sample_id: sample.sample_id,
    variant,
    artifact,
    prompt: sample.prompt,
    rubric: sample.rubric ?? null,
    assertions: sample.assertions ?? null,
    dimensions: sample.dimensions ?? null,
    artifactContent: artifact.content,
    cwd: null,
    _sample: sample,
  };
}

function writeFakeBinary(dir: string, name: string, output: string): void {
  const fileName = process.platform === 'win32' ? `${name}.cmd` : name;
  const filePath = join(dir, fileName);
  const content = process.platform === 'win32'
    ? `@echo off\r\necho ${output}\r\n`
    : `#!/bin/sh\necho ${output}\n`;
  writeFileSync(filePath, content);
  if (process.platform !== 'win32') chmodSync(filePath, 0o755);
}

describe('aggregateReport — reproducibility metadata', () => {
  const baseOpts = {
    runId: 'run-1',
    variants: ['v1'],
    model: 'haiku',
    judgeModel: 'haiku',
    noJudge: false,
    executorName: 'claude',
    samples: [makeSample('s1', 'task one', 'rubric one'), makeSample('s2', 'task two')],
    tasks: [] as Task[],
    results: { s1: { v1: makeVariantResult() }, s2: { v1: makeVariantResult() } },
    totalCostUSD: 0.002,
    artifacts: [makeArtifact('v1', 'skill content')],
  };

  it('writes sampleHashes — one entry per sample, 12-char hex hashes', () => {
    const report = aggregateReport(baseOpts);
    assert.ok(report.meta.sampleHashes, 'sampleHashes should be present');
    const ids = Object.keys(report.meta.sampleHashes!);
    assert.deepEqual(ids.sort(), ['s1', 's2']);
    for (const hash of Object.values(report.meta.sampleHashes!)) {
      assert.match(hash, /^[0-9a-f]{12}$/);
    }
    // Different content → different hashes
    assert.notEqual(report.meta.sampleHashes!.s1, report.meta.sampleHashes!.s2);
  });

  it('sampleHashes is stable: same sample content → same hash across calls', () => {
    const r1 = aggregateReport(baseOpts);
    const r2 = aggregateReport(baseOpts);
    assert.equal(r1.meta.sampleHashes!.s1, r2.meta.sampleHashes!.s1);
    assert.equal(r1.meta.sampleHashes!.s2, r2.meta.sampleHashes!.s2);
  });

  it('sampleHashes cover execution context, sandboxing, and diagnostic semantics', () => {
    const base: Sample = { sample_id: 'base', prompt: 'same prompt' };
    const variants: Sample[] = [
      { ...base, sample_id: 'context', context: 'fixture context' },
      { ...base, sample_id: 'cwd', cwd: '/fixture/project' },
      {
        ...base,
        sample_id: 'mocks',
        mocks: [{ tool: 'Read', return: 'fixture' }],
        mocksStrict: true,
      },
      {
        ...base,
        sample_id: 'environment',
        environment: { cli_available: ['gh'] },
      },
      { ...base, sample_id: 'tripwire', tripwire: true },
      { ...base, sample_id: 'metadata', construct: 'necessity' },
    ];
    const hashes = aggregateReport({
      ...baseOpts,
      samples: [base, ...variants],
      results: Object.fromEntries(
        [base, ...variants].map((sample) => [
          sample.sample_id,
          { v1: makeVariantResult() },
        ]),
      ),
    }).meta.sampleHashes!;

    for (const sample of variants) {
      assert.notEqual(hashes.base, hashes[sample.sample_id], sample.sample_id);
    }
  });

  it('persists the execution contract needed to explain a sample hash', () => {
    const sample: Sample = {
      sample_id: 'contract',
      prompt: 'run the workflow',
      cwd: '/fixture/project',
      dimensions: { correctness: 'must be correct' },
      mocks: [{ tool: 'Read', return: 'fixture' }],
      mocksStrict: true,
      environment: {
        cli_available: ['gh'],
        files_available: ['README.md'],
        notes: 'credentials are ready',
      },
      allowedTools: ['Read'],
      expectedTools: ['Read'],
      provenance: 'production-trace',
      sourceRefs: [{
        sourceType: 'knowledge_gap',
        sourceId: 'knowledge-gap:release',
        experienceSessionId: 'experience:release',
        sourceTrace: '/traces/codex.jsonl',
      }],
    };
    const artifact = makeArtifact('v1', 'skill content');
    const report = aggregateReport({
      ...baseOpts,
      samples: [sample],
      tasks: [makeTask('v1', artifact, sample)],
      results: { contract: { v1: makeVariantResult() } },
      totalCostUSD: 0.001,
      artifacts: [artifact],
    });

    assert.deepEqual(report.sampleSnapshots?.contract, {
      sample_id: 'contract',
      prompt: 'run the workflow',
      cwd: '/fixture/project',
      dimensions: { correctness: 'must be correct' },
      mocks: [{ tool: 'Read', return: 'fixture' }],
      mocksStrict: true,
      environment: {
        cli_available: ['gh'],
        files_available: ['README.md'],
        notes: 'credentials are ready',
      },
      allowedTools: ['Read'],
      expectedTools: ['Read'],
      provenance: 'production-trace',
      sourceRefs: [{
        sourceType: 'knowledge_gap',
        sourceId: 'knowledge-gap:release',
        experienceSessionId: 'experience:release',
        sourceTrace: '/traces/codex.jsonl',
      }],
    });
    assert.ok(parseReportDocument(report, report.id, report.id));
  });

  it('aggregates prototype-shaped sample and variant names without inherited values', () => {
    const sample = makeSample('constructor', 'task');
    const artifact = makeArtifact('__proto__', 'skill content');
    const report = aggregateReport({
      ...baseOpts,
      variants: ['__proto__'],
      samples: [sample],
      tasks: [makeTask('__proto__', artifact, sample)],
      results: JSON.parse(JSON.stringify({
        constructor: JSON.parse('{"__proto__":{"ok":true,"durationMs":1,"inputTokens":1,"outputTokens":1,"totalTokens":2,"cacheReadTokens":0,"cacheCreationTokens":0,"execCostUSD":0,"judgeCostUSD":0,"costUSD":0,"numTurns":1,"outputPreview":"ok"}}'),
      })),
      artifacts: [artifact],
    });

    assert.equal(Object.hasOwn(report.summary, '__proto__'), true);
    assert.equal(report.summary.__proto__.totalSamples, 1);
    assert.equal(Object.hasOwn(report.meta.sampleHashes!, 'constructor'), true);
  });

  it('writes judgePromptHash when noJudge=false', () => {
    const report = aggregateReport(baseOpts);
    assert.ok(report.meta.judgePromptHash, 'judgePromptHash should be set');
    assert.match(report.meta.judgePromptHash!, /^[0-9a-f]{12}$/);
  });

  it('writes and validates the source-neutral diagnostic contract', () => {
    const sample = makeSample('diagnostic', 'task', 'rubric');
    const artifact = makeArtifact('v1', 'skill content');
    const report = aggregateReport({
      ...baseOpts,
      samples: [sample],
      tasks: [makeTask('v1', artifact, sample)],
      results: { diagnostic: { v1: makeVariantResult() } },
      totalCostUSD: 0.001,
      artifacts: [artifact],
    });
    assert.equal(report.meta.diagnostic?.enabled, true);
    assert.equal(report.meta.diagnostic?.executor, 'claude');
    assert.equal(report.meta.diagnostic?.model, 'haiku');
    assert.match(report.meta.diagnostic?.promptHash ?? '', /^[0-9a-f]{12}$/);
    assert.ok(parseReportDocument(report, report.id, report.id));

    const malformed = structuredClone(report);
    malformed.meta.diagnostic!.runtime!.model = 'different-model';
    assert.equal(parseReportDocument(malformed, malformed.id, malformed.id), null);
  });

  it('writes executor runtime fingerprint', () => {
    const report = aggregateReport({ ...baseOpts, executorName: 'codex-sdk', model: 'gpt-5', noJudge: true });
    assert.equal(report.meta.executorRuntime?.executor, 'codex-sdk');
    assert.equal(report.meta.executorRuntime?.model, 'gpt-5');
    assert.equal(report.meta.executorRuntime?.runtimeKind, 'agent-sdk');
    assert.match(report.meta.executorRuntime!.fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(report.meta.executorRuntime?.sdk?.name, '@openai/codex-sdk');
    assert.equal(report.meta.executorRuntime?.binary?.source, 'bundled');
    assert.equal(report.meta.executorRuntime?.binary?.package?.name, '@openai/codex');
    assert.equal(report.meta.executorRuntime?.capabilities.costUSD, 'not-reported');
    assert.equal(report.meta.noJudge, true);
    assert.equal(report.meta.judgeModels[0]?.runtime, undefined);
  });

  it('writes per-variant executor runtime fingerprints from each task skillDir', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-runtime-report-'));
    try {
      const skillA = join(root, 'skill-a');
      const skillB = join(root, 'skill-b');
      for (const [dir, version] of [[skillA, 'codex-a'], [skillB, 'codex-b']] as const) {
        mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
        writeFakeBinary(join(dir, 'node_modules', '.bin'), 'codex', version);
        writeFileSync(join(dir, 'SKILL.md'), `${version} skill`);
      }
      const artifactA: Artifact = { name: 'a', kind: 'skill', source: 'file-path', content: 'a skill', locator: join(skillA, 'SKILL.md'), experimentRole: 'control' };
      const artifactB: Artifact = { name: 'b', kind: 'skill', source: 'file-path', content: 'b skill', locator: join(skillB, 'SKILL.md'), experimentRole: 'treatment' };
      const sample = makeSample('s1', 'task');
      const report = aggregateReport({
        runId: 'run-1',
        variants: ['a', 'b'],
        model: 'gpt-5',
        judgeModel: 'haiku',
        noJudge: true,
        executorName: 'codex',
        samples: [sample],
        tasks: [makeTask('a', artifactA, sample), makeTask('b', artifactB, sample)],
        results: { s1: { a: makeVariantResult(), b: makeVariantResult() } },
        totalCostUSD: 0,
        artifacts: [artifactA, artifactB],
      });

      assert.equal(report.meta.executorRuntimes?.a.binary?.version, 'codex-a');
      assert.equal(report.meta.executorRuntimes?.b.binary?.version, 'codex-b');
      assert.notEqual(report.meta.executorRuntimes?.a.fingerprint, report.meta.executorRuntimes?.b.fingerprint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes judge runtime fingerprint when judge runs', () => {
    const report = aggregateReport(baseOpts);
    const judge = report.meta.judgeModels[0];
    assert.equal(judge.executor, 'claude');
    assert.equal(judge.model, 'haiku');
    assert.match(judge.runtime!.fingerprint, /^[0-9a-f]{12}$/);
  });

  it('writes structured judgeModels with per-entry runtime for ensemble reports', () => {
    const request: EvaluationRequest = {
      samplesPath: '/tmp/s.json',
      skillDir: '/tmp',
      artifacts: [],
      model: 'haiku',
      executor: 'claude',
      noJudge: false,
      concurrency: 1,
      noCache: false,
      dryRun: false,
      judgeModels: [
        { executor: 'claude', model: 'sonnet' },
        { executor: 'codex', model: 'gpt-5.5' },
      ],
    };

    const report = aggregateReport({ ...baseOpts, request });

    assert.equal(report.meta.judgeModels.length, 2);
    assert.equal(report.meta.judgeModels[0].executor, 'claude');
    assert.equal(report.meta.judgeModels[0].model, 'sonnet');
    assert.equal(report.meta.judgeModels[1].executor, 'codex');
    assert.equal(report.meta.judgeModels[1].model, 'gpt-5.5');
    assert.ok(report.meta.judgeModels[0].runtime);
    assert.ok(report.meta.judgeModels[1].runtime);
  });

  it('marks totalCostReported=false when any judge cost is not reported', () => {
    const result = { ...makeVariantResult(), judgeCostReportedByExecutor: false as const };
    const report = aggregateReport({
      ...baseOpts,
      results: { s1: { v1: result } },
      totalCostUSD: result.costUSD,
    });

    assert.equal(report.meta.totalCostReported, false);
  });

  it('omits judgePromptHash when noJudge=true (no judge ran)', () => {
    const report = aggregateReport({ ...baseOpts, noJudge: true });
    assert.equal(report.meta.judgePromptHash, undefined);
  });

  it('writes judgeRepeat when request.judgeRepeat > 1', () => {
    const request: EvaluationRequest = {
      samplesPath: '/tmp/s.json', skillDir: '/tmp', artifacts: [], model: 'haiku',
      judgeModels: [{ executor: 'claude', model: 'haiku' }],
      executor: 'claude', noJudge: false, concurrency: 1, noCache: false, dryRun: false,
      judgeRepeat: 3,
    };
    const report = aggregateReport({ ...baseOpts, request });
    assert.equal(report.meta.judgeRepeat, 3);
  });

  it('omits judgeRepeat when request.judgeRepeat is 1 or unset (avoid noise)', () => {
    const request1: EvaluationRequest = {
      samplesPath: '/tmp/s.json', skillDir: '/tmp', artifacts: [], model: 'haiku',
      judgeModels: [{ executor: 'claude', model: 'haiku' }],
      executor: 'claude', noJudge: false, concurrency: 1, noCache: false, dryRun: false,
      judgeRepeat: 1,
    };
    const r1 = aggregateReport({ ...baseOpts, request: request1 });
    assert.equal(r1.meta.judgeRepeat, undefined);

    const r2 = aggregateReport(baseOpts); // no request at all
    assert.equal(r2.meta.judgeRepeat, undefined);
  });
});

describe('aggregateReport — sampleHash key-order stability', () => {
  // The whole point of canonical JSON: key insertion order shouldn't affect hash.
  // Two samples with the same dimensions but different key insertion order must hash equal.
  function commonOpts(samples: Sample[]) {
    return {
      runId: 'r', variants: ['v1'], model: 'haiku', judgeModel: 'haiku', noJudge: false,
      executorName: 'claude',
      samples,
      tasks: [] as Task[],
      results: Object.fromEntries(samples.map((s) => [s.sample_id, { v1: makeVariantResult() }])),
      totalCostUSD: 0,
      artifacts: [makeArtifact('v1', 'c')],
    };
  }

  it('different dimensions key insertion order → same hash', () => {
    const a: Sample = { sample_id: 'a', prompt: 'p', dimensions: { correctness: 'r1', clarity: 'r2' } };
    // Build via a different path so JS engine may iterate keys in a different order
    const dims: Record<string, string> = {};
    dims.clarity = 'r2';
    dims.correctness = 'r1';
    const b: Sample = { sample_id: 'b', prompt: 'p', dimensions: dims };
    const r = aggregateReport(commonOpts([a, b]));
    assert.equal(r.meta.sampleHashes!.a, r.meta.sampleHashes!.b);
  });

  it('different assertions array order → DIFFERENT hash (order is meaningful)', () => {
    // Arrays, unlike object keys, have semantic order — assertion order may matter
    // for evaluation pipelines (e.g. early-exit). Hash should reflect that.
    const a: Sample = {
      sample_id: 'a', prompt: 'p',
      assertions: [{ type: 'contains', value: 'foo', weight: 1 }, { type: 'contains', value: 'bar', weight: 1 }],
    };
    const b: Sample = {
      sample_id: 'b', prompt: 'p',
      assertions: [{ type: 'contains', value: 'bar', weight: 1 }, { type: 'contains', value: 'foo', weight: 1 }],
    };
    const r = aggregateReport(commonOpts([a, b]));
    assert.notEqual(r.meta.sampleHashes!.a, r.meta.sampleHashes!.b);
  });

  it('same prompt + different rubric → different hash', () => {
    const a: Sample = { sample_id: 'a', prompt: 'p', rubric: 'rubric one' };
    const b: Sample = { sample_id: 'b', prompt: 'p', rubric: 'rubric two' };
    const r = aggregateReport(commonOpts([a, b]));
    assert.notEqual(r.meta.sampleHashes!.a, r.meta.sampleHashes!.b);
  });

  it('same prompt + different dimensions → different hash', () => {
    const a: Sample = { sample_id: 'a', prompt: 'p', dimensions: { acc: 'is it accurate' } };
    const b: Sample = { sample_id: 'b', prompt: 'p', dimensions: { acc: 'is it accurate', clarity: 'is it clear' } };
    const r = aggregateReport(commonOpts([a, b]));
    assert.notEqual(r.meta.sampleHashes!.a, r.meta.sampleHashes!.b);
  });
});

describe('aggregateReport — meta.skillIsolation', () => {
  function withIsolation(name: string, allowed?: string[]): Artifact {
    const a: Artifact = { name, kind: 'baseline', source: 'baseline', content: null, experimentRole: 'control' };
    if (allowed !== undefined) a.allowedSkills = allowed;
    return a;
  }

  const baseSample = makeSample('s1', 'p');
  const baseResult: VariantResult = makeVariantResult();

  it('每个 variant 的 allowedSkills 写入 meta.skillIsolation(strict baseline []]', () => {
    const report = aggregateReport({
      runId: 'r',
      variants: ['baseline', 'skillA'],
      model: 'haiku', judgeModel: 'haiku', noJudge: false, executorName: 'claude',
      samples: [baseSample], tasks: [], totalCostUSD: 0,
      results: { s1: { baseline: baseResult, skillA: baseResult } },
      artifacts: [
        withIsolation('baseline', []),
        { name: 'skillA', kind: 'skill', source: 'inline', content: 'skillA skill', experimentRole: 'treatment' },
      ],
    });
    assert.ok(report.meta.skillIsolation, 'skillIsolation 必须 populate');
    assert.deepEqual(report.meta.skillIsolation!.baseline, []);
    assert.equal(report.meta.skillIsolation!.skillA, null,
      'undefined 序列化为 null,跨 variant 都有 entry');
  });

  it('白名单也写入 meta.skillIsolation', () => {
    const report = aggregateReport({
      runId: 'r',
      variants: ['skill-clean'],
      model: 'haiku', judgeModel: 'haiku', noJudge: false, executorName: 'claude',
      samples: [baseSample], tasks: [], totalCostUSD: 0,
      results: { s1: { 'skill-clean': baseResult } },
      artifacts: [withIsolation('skill-clean', ['react-skill'])],
    });
    assert.deepEqual(report.meta.skillIsolation!['skill-clean'], ['react-skill']);
  });
});

describe('aggregateReport — 配对 pairwise diff CI(#235 审计 PR3)', () => {
  const withComposite = (composite: number): VariantResult => ({ ...makeVariantResult(), compositeScore: composite });
  const reqBootstrap = { bootstrap: true } as unknown as EvaluationRequest;

  it('开 bootstrap + 2 variant:按 sample 配对算 diff CI(treatment 稳定高于 control → 显著正 Δ)', () => {
    const ids = ['s1', 's2', 's3', 's4', 's5'];
    const aScores = [3.0, 3.5, 4.0, 2.5, 3.8];
    const bScores = [3.8, 4.3, 4.8, 3.3, 4.6]; // 每个 sample 上 b 比 a 高约 0.8 → 配对差稳定为正
    const results = Object.fromEntries(ids.map((id, i) => [id, { a: withComposite(aScores[i]), b: withComposite(bScores[i]) }]));
    const report = aggregateReport({
      runId: 'r', variants: ['a', 'b'], model: 'm', judgeModel: 'haiku', noJudge: true,
      executorName: 'codex', samples: ids.map((id) => makeSample(id, 'task')), tasks: [],
      results, totalCostUSD: 0, artifacts: [makeArtifact('a', 'a'), makeArtifact('b', 'b')],
      request: reqBootstrap,
    });
    const pair = report.meta.pairComparisons?.[0];
    assert.ok(pair?.diffBootstrapCI, '应产出配对 diffBootstrapCI');
    assert.equal(pair!.control, 'a');
    assert.equal(pair!.treatment, 'b');
    assert.ok(pair!.diffBootstrapCI!.estimate > 0, 'treatment 高于 control → 正 Δ');
    assert.ok(pair!.diffBootstrapCI!.significant, '稳定正向配对差 → 显著');
  });

  it('某 sample 一侧缺测(composite 0)→ 该 sample 不入配对对,其余仍成对', () => {
    const results = {
      s1: { a: withComposite(3.0), b: withComposite(4.0) },
      s2: { a: withComposite(3.0), b: withComposite(0) }, // b 在 s2 缺测 → s2 被排除
      s3: { a: withComposite(3.5), b: withComposite(4.2) },
    };
    const report = aggregateReport({
      runId: 'r', variants: ['a', 'b'], model: 'm', judgeModel: 'haiku', noJudge: true,
      executorName: 'codex', samples: ['s1', 's2', 's3'].map((id) => makeSample(id, 'task')), tasks: [],
      results, totalCostUSD: 0, artifacts: [makeArtifact('a', 'a'), makeArtifact('b', 'b')],
      request: reqBootstrap,
    });
    assert.ok(report.meta.pairComparisons?.[0]?.diffBootstrapCI, 's2 缺测但 s1/s3 仍成对 → 仍出配对 diff CI');
  });
});

describe('aggregateReport — 多重比较 Bonferroni 校正(#235 审计 PR4)', () => {
  const withComposite = (composite: number): VariantResult => ({ ...makeVariantResult(), compositeScore: composite });
  const reqBootstrap = { bootstrap: true } as unknown as EvaluationRequest;
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
  // 各 variant 在每个 sample 上的 composite;a = control。
  const scores: Record<string, number[]> = {
    a: [3.0, 3.5, 4.0, 2.5, 3.8, 3.2],
    b: [4.0, 3.6, 4.8, 2.6, 4.6, 3.3],
    c: [3.1, 3.4, 3.9, 2.6, 3.7, 3.3],
    d: [3.5, 4.0, 4.4, 3.0, 4.2, 3.6],
  };
  const build = (variants: string[]) => aggregateReport({
    runId: 'r', variants, model: 'm', judgeModel: 'haiku', noJudge: true, executorName: 'codex',
    samples: ids.map((id) => makeSample(id, 'task')), tasks: [],
    results: Object.fromEntries(ids.map((id, i) => [id, Object.fromEntries(variants.map((v) => [v, withComposite(scores[v][i])]))])),
    totalCostUSD: 0, artifacts: variants.map((v) => makeArtifact(v, v)),
    request: reqBootstrap,
  });

  it('K=1(经典 A-B):不写 alpha 字段,CI 口径与历史一致(名义 α=0.05)', () => {
    const pairs = build(['a', 'b']).meta.pairComparisons!;
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].alpha, undefined, 'K=1 不写 alpha,渲染按名义 95%,既有快照不动');
  });

  it('K=2:每对 CI 用 α/K=0.025,记录有效 alpha,且较 K=1 同对(α=0.05)更宽(点估计不变)', () => {
    const k1 = build(['a', 'b']).meta.pairComparisons!;
    const k2 = build(['a', 'b', 'c']).meta.pairComparisons!;
    assert.equal(k2.length, 2, 'control 外两 treatment → 两个比较');
    for (const p of k2) assert.equal(p.alpha, 0.05 / 2, '每对有效 α = α/K = 0.025');
    const ab1 = k1.find((p) => p.treatment === 'b')!.diffBootstrapCI!;
    const ab2 = k2.find((p) => p.treatment === 'b')!.diffBootstrapCI!;
    const width = (ci: { low: number; high: number }): number => ci.high - ci.low;
    assert.ok(width(ab2) > width(ab1), `K=2 的 (a,b) CI 宽 ${width(ab2)} 应 > K=1 的 ${width(ab1)}`);
    assert.equal(ab2.estimate, ab1.estimate, '同一份 (a,b) 数据点估计与 K 无关');
  });

  it('K=3:有效 α = α/3,三个比较都带同一 alpha', () => {
    const k3 = build(['a', 'b', 'c', 'd']).meta.pairComparisons!;
    assert.equal(k3.length, 3);
    for (const p of k3) assert.ok(Math.abs(p.alpha! - 0.05 / 3) < 1e-12, `每对 α 应 ≈ α/3,实得 ${p.alpha}`);
  });

  it('实锤:边界对在 K=1 显著,纳入 K=2(α/2)后翻为不显著 —— family-wise 假阳被压下', () => {
    // 这组配对差在默认种子下,α=0.05 的 CI 下界 +0.025(显著)、α/2=0.025 的下界 −0.017(含 0,不显著)——
    // 正是多重比较该挡的边界假阳性。a 取常量 3.0、b = 3.0 + diff(全 > 0 成对);第三个 treatment c 只为把 K 撑到 2。
    const diffs = [0.35, 0.25, 0.45, -0.45, 0.35, 0.55, -0.35, 0.35, 0.65, -0.15, 0.45, 0.35];
    const fids = diffs.map((_, i) => `f${i + 1}`);
    const mk = (variants: string[]) => aggregateReport({
      runId: 'r', variants, model: 'm', judgeModel: 'haiku', noJudge: true, executorName: 'codex',
      samples: fids.map((id) => makeSample(id, 'task')), tasks: [],
      results: Object.fromEntries(fids.map((id, i) => {
        const row: Record<string, VariantResult> = { a: withComposite(3.0), b: withComposite(3.0 + diffs[i]) };
        if (variants.includes('c')) row.c = withComposite(3.1);
        return [id, row];
      })),
      totalCostUSD: 0, artifacts: variants.map((v) => makeArtifact(v, v)), request: reqBootstrap,
    });
    const ab1 = mk(['a', 'b']).meta.pairComparisons!.find((p) => p.treatment === 'b')!;
    const ab2 = mk(['a', 'b', 'c']).meta.pairComparisons!.find((p) => p.treatment === 'b')!;
    assert.equal(ab1.alpha, undefined, 'K=1 名义 α');
    assert.equal(ab1.diffBootstrapCI!.significant, true, 'K=1(α=0.05)边界对显著');
    assert.equal(ab2.alpha, 0.05 / 2, 'K=2 → α/2');
    assert.equal(ab2.diffBootstrapCI!.significant, false, 'K=2(α/2=0.025)同一份 (a,b) 翻为不显著 → 假阳被压下');
    assert.equal(ab1.diffBootstrapCI!.estimate, ab2.diffBootstrapCI!.estimate, '点估计与 K 无关,不变');
  });
});
