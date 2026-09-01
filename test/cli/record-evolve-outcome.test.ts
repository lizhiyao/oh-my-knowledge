/**
 * recordEvolveOutcome 单测:evolve 写回 source 后,为「受管」skill 记一条带 verdict 的证据 + 把记录
 * re-baseline 到新版本 → omk list 显 measurable(而非永久 stale)。**不写 promote 决定**(A 方案:升 promoted
 * 仍由人 omk promote)。loadReport / dir 走覆盖,故全程不触网、不读全局受管目录。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { recordEvolveOutcome } from '../../src/cli/lib/record-evolve-outcome.js';
import { managedRecordId, hashArtifactSource, deriveManagedState } from '../../src/managed/index.js';
import { computeVerdict } from '../../src/eval-core/verdict.js';
import type { EvaluationReport, ManagedArtifactRecord } from '../../src/types/index.js';

/** 多轮 merged 报告 fixture：每个变体一个均分，per-sample 带小确定性方差（避免 bootstrap 0 方差退化）。 */
function multiRoundReport(composites: Record<string, number>): EvaluationReport {
  const variants = Object.keys(composites);
  const N = 8;
  const vr = (base: number, i: number, sid: string) => ({
    sample_id: sid, status: 'success' as const, output: '', compositeScore: base + (i % 2 === 0 ? 0.05 : -0.05),
    factScore: base, behaviorScore: base, judgeScore: base,
    durationMs: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0, numTurns: 1,
  });
  const summaryOf = (base: number) => ({
    totalSamples: N, successCount: N, errorCount: 0, errorRate: 0,
    avgDurationMs: 1, avgInputTokens: 1, avgOutputTokens: 1, avgTotalTokens: 2,
    totalCostUSD: 0, totalExecCostUSD: 0, totalJudgeCostUSD: 0, avgCostPerSample: 0, avgNumTurns: 1,
    avgFactScore: base, avgBehaviorScore: base, avgJudgeScore: base, avgCompositeScore: base,
  });
  const results = Array.from({ length: N }, (_, i) => ({
    sample_id: `s${i}`,
    variants: Object.fromEntries(variants.map((v) => [v, vr(composites[v], i, `s${i}`)])),
  }));
  return {
    kind: 'evaluation', id: 'evolve-review-abc123',
    meta: {
      variants, model: 'm', judgeModels: [{ executor: 'claude', model: 'j' }], executor: 'claude',
      sampleCount: N, taskCount: N, totalCostUSD: 0, timestamp: '2026-06-10T00:00:00Z',
      cliVersion: '0.37.0', nodeVersion: 'test', judgePromptHash: 'jph',
      artifactHashes: Object.fromEntries(variants.map((v) => [v, `h-${v}`])),
    },
    summary: Object.fromEntries(variants.map((v) => [v, summaryOf(composites[v])])),
    results,
  } as unknown as EvaluationReport;
}

/** 合并 evolve 报告样子的最小 fixture:两变体 round-0 / round-1,带 per-sample composite 供 verdict 用。 */
function fixtureReport(oldHash: string, winnerHash: string): EvaluationReport {
  const variantResult = (composite: number) => ({
    sample_id: 's', status: 'success' as const, output: '', compositeScore: composite,
    factScore: composite, behaviorScore: composite, judgeScore: composite,
    durationMs: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0, numTurns: 1,
  });
  const summaryOf = (composite: number) => ({
    totalSamples: 6, successCount: 6, errorCount: 0, errorRate: 0,
    avgDurationMs: 1, avgInputTokens: 1, avgOutputTokens: 1, avgTotalTokens: 2,
    totalCostUSD: 0, totalExecCostUSD: 0, totalJudgeCostUSD: 0, avgCostPerSample: 0, avgNumTurns: 1,
    avgFactScore: composite, avgBehaviorScore: composite, avgJudgeScore: composite, avgCompositeScore: composite,
  });
  const results = Array.from({ length: 6 }, (_, i) => ({
    sample_id: `s${i}`,
    variants: { 'round-0': { ...variantResult(4.0), sample_id: `s${i}` }, 'round-1': { ...variantResult(4.4), sample_id: `s${i}` } },
  }));
  return {
    kind: 'evaluation', id: 'evolve-review-abc123',
    meta: {
      variants: ['round-0', 'round-1'],
      model: 'm', judgeModels: [{ executor: 'claude', model: 'j' }], executor: 'claude',
      sampleCount: 6, taskCount: 6, totalCostUSD: 0,
      timestamp: '2026-06-10T00:00:00Z', cliVersion: '0.37.0', nodeVersion: 'test',
      judgePromptHash: 'jph', artifactHashes: { 'round-0': oldHash, 'round-1': winnerHash },
    },
    summary: { 'round-0': summaryOf(4.0), 'round-1': summaryOf(4.4) },
    results,
  } as unknown as EvaluationReport;
}

describe('recordEvolveOutcome', () => {
  let dir: string;
  let proj: string;
  let skillPath: string;
  let recId: string;
  let oldHash: string;
  let newHash: string;

  function writeRecord(over: Partial<ManagedArtifactRecord> = {}): void {
    const rec: ManagedArtifactRecord = {
      recordKind: 'managed-artifact', schemaVersion: 2, id: recId, name: 'review', kind: 'skill',
      source: { sourceKind: 'file', locator: skillPath, isDirectorySkill: false },
      contentHash: oldHash, installedAt: '2026-06-06T00:00:00.000Z',
      distribution: [], evidence: [], decisions: [],
      ...over,
    };
    writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec));
  }
  const loadRec = (): ManagedArtifactRecord => JSON.parse(readFileSync(join(dir, `${recId}.json`), 'utf-8'));

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'omk-evo-outcome-'));
    dir = join(proj, 'managed');
    mkdirSync(dir, { recursive: true });
    skillPath = join(proj, 'review.md');
    // 模拟 evolve 已把胜出版本写回 source → 当前文件 = 新内容。
    writeFileSync(skillPath, '# review skill\n\nthe EVOLVED, better version.\n');
    newHash = hashArtifactSource(skillPath, false);
    oldHash = `old-${newHash}`; // 安装基线 ≠ 当前(制造漂移),re-baseline 应消解之
    recId = managedRecordId('skill', 'review');
  });
  afterEach(() => rmSync(proj, { recursive: true, force: true }));

  const load = (id = 'evolve-review-abc123') => async (): Promise<EvaluationReport | null> =>
    id === 'evolve-review-abc123' ? fixtureReport(oldHash, newHash) : null;

  it('旧 evolve report 仅留审计证据，不再把状态提升为 measurable', async () => {
    writeRecord();
    const out = await recordEvolveOutcome({
      reportId: 'evolve-review-abc123', bestRound: 1, skillPath, skillDir: dirname(skillPath), isDirectorySkill: false, dir,
      loadReport: load(),
    });
    assert.ok(out, '受管 + 改进应记一条结果');
    assert.equal(out!.contentHash, newHash, '锚定 re-baseline 后的新源哈');
    assert.ok(typeof out!.verdict === 'string' && out!.verdict.length > 0, '带 verdict');

    const rec = loadRec();
    assert.equal(rec.contentHash, newHash, '记录已 re-baseline 到新内容(不再 stale)');
    assert.equal(rec.evidence.length, 1, '追加一条证据');
    assert.equal(rec.evidence[0].contentHash, newHash, '证据锚定当前内容');
    assert.equal(rec.decisions.length, 0, 'A 方案:evolve 不写 promote 决定');

    const state = deriveManagedState({ record: rec, currentContentHash: newHash });
    assert.equal(state.label, 'installed', '只有 Evaluation Core evidence 才能提升生命周期状态');
  });

  it('未纳管(无匹配源的记录) → no-op 返回 null', async () => {
    // 写一条源指向别处的记录 → 按源匹配不到本 skill。
    writeRecord({ source: { sourceKind: 'file', locator: join(proj, 'other.md'), isDirectorySkill: false } });
    const out = await recordEvolveOutcome({
      reportId: 'evolve-review-abc123', bestRound: 1, skillPath, skillDir: dirname(skillPath), isDirectorySkill: false, dir, loadReport: load(),
    });
    assert.equal(out, null);
    assert.equal(loadRec().evidence.length, 0, '不为未匹配记录写证据');
  });

  it('切片去污染 + 等价 eval:merged 含 round-0..3 时只按 round-0 vs round-bestRound 算 verdict', async () => {
    // round-1 远低于基线（若被算进 worst-case roll-up → 非 PROGRESS）；round-2（胜出）显著高于基线；round-3≈基线。
    const report = multiRoundReport({ 'round-0': 4.0, 'round-1': 2.0, 'round-2': 4.6, 'round-3': 4.0 });
    writeRecord();
    const out = await recordEvolveOutcome({
      reportId: 'evolve-review-abc123', bestRound: 2,
      skillPath, skillDir: dirname(skillPath), isDirectorySkill: false, dir,
      loadReport: async () => report,
    });
    assert.equal(out?.verdict, 'PROGRESS', 'round-2 vs round-0 是干净显著正向 → PROGRESS，未被 round-1 的 regress 污染');
    // 对照：整份报告（含 round-1 regress）的 worst-case verdict 不是 PROGRESS —— 证明切片确实只取了 round-0/round-2。
    assert.notEqual(computeVerdict(report).level, 'PROGRESS', '全报告 worst-case 含 round-1 regress 应非 PROGRESS（佐证切片去污染）');
  });

  it('形态隔离:对文件-skill 跑 evolve 不会误命中同父目录的「目录-skill」记录', async () => {
    // 一条目录-skill 记录,locator 恰为本 skill 的父目录(= skillDir)。旧并集匹配会让它被 skillDir 命中。
    writeRecord({
      source: { sourceKind: 'file', locator: dirname(skillPath), isDirectorySkill: true },
    });
    const out = await recordEvolveOutcome({
      reportId: 'evolve-review-abc123', bestRound: 1,
      skillPath, skillDir: dirname(skillPath), isDirectorySkill: false, dir, // evolve 的是文件-skill
      loadReport: load(),
    });
    assert.equal(out, null, '形态不一致(文件 vs 目录)→ 不匹配,不误写');
    assert.equal(loadRec().evidence.length, 0, '目录-skill 记录不应被写证据');
    assert.equal(loadRec().contentHash, oldHash, '不应被 re-baseline 成文件哈');
  });

  it('目录-skill 以 .../SKILL.md 形态传入 → 命中目录形态记录并 re-baseline(P1 正向回归)', async () => {
    // 帮助文档鼓励 `omk evolve skills/foo/SKILL.md`,evolve 按解析后形态判 isDirectorySkill=true。
    // install 落的目录记录是 isDirectorySkill=true + locator=skill 根目录。这条必须命中,否则最常见的目录
    // skill 用法下漂移永不消、evolve 证据永不沉淀(回归之前 skillIsDir 错按「入参是不是目录」判 false 的 bug)。
    const skillRoot = join(proj, 'mydir');
    mkdirSync(skillRoot, { recursive: true });
    const skillMd = join(skillRoot, 'SKILL.md');
    writeFileSync(skillMd, '# dir skill\n\nthe EVOLVED, better tree.\n'); // 模拟 evolve 已写回 SKILL.md
    const dirNewHash = hashArtifactSource(skillRoot, true); // 整树哈,与 probeSourceState 同口径
    const dirRecId = managedRecordId('skill', 'mydir');
    const rec: ManagedArtifactRecord = {
      recordKind: 'managed-artifact', schemaVersion: 2, id: dirRecId, name: 'mydir', kind: 'skill',
      source: { sourceKind: 'file', locator: skillRoot, isDirectorySkill: true }, // 目录形态:locator=根目录
      contentHash: `old-${dirNewHash}`, installedAt: '2026-06-06T00:00:00.000Z', // 基线故意漂移
      distribution: [], evidence: [], decisions: [],
    };
    writeFileSync(join(dir, `${dirRecId}.json`), JSON.stringify(rec));

    const out = await recordEvolveOutcome({
      reportId: 'evolve-review-abc123', bestRound: 1,
      skillPath: skillMd, skillDir: skillRoot, isDirectorySkill: true, dir, // 传 SKILL.md 文件路径,但形态是目录
      loadReport: async () => fixtureReport('old-tree', dirNewHash),
    });
    assert.ok(out, '目录 skill 传 SKILL.md 应命中目录形态记录');
    assert.equal(out!.contentHash, dirNewHash, '锚定整树哈 re-baseline');

    const saved: ManagedArtifactRecord = JSON.parse(readFileSync(join(dir, `${dirRecId}.json`), 'utf-8'));
    assert.equal(saved.contentHash, dirNewHash, '记录 re-baseline 到整树新哈(不再 stale)');
    assert.equal(saved.evidence.length, 1, '追加一条证据');
    assert.equal(saved.evidence[0].contentHash, dirNewHash, '证据锚定整树当前内容');
    assert.equal(deriveManagedState({ record: saved, currentContentHash: dirNewHash }).label, 'installed');
  });

  it('无改进(bestRound=0) → no-op', async () => {
    writeRecord();
    const out = await recordEvolveOutcome({
      reportId: 'evolve-review-abc123', bestRound: 0, skillPath, skillDir: dirname(skillPath), isDirectorySkill: false, dir, loadReport: load(),
    });
    assert.equal(out, null);
    assert.equal(loadRec().evidence.length, 0);
    assert.equal(loadRec().contentHash, oldHash, '无改进不 re-baseline');
  });

  it('源不可达 → no-op(不写证据、不 re-baseline)', async () => {
    rmSync(skillPath); // 源文件没了 → probe unreachable
    writeRecord();
    const out = await recordEvolveOutcome({
      reportId: 'evolve-review-abc123', bestRound: 1, skillPath, skillDir: dirname(skillPath), isDirectorySkill: false, dir, loadReport: load(),
    });
    assert.equal(out, null);
    assert.equal(loadRec().contentHash, oldHash);
  });

  it('胜出轮缺失于报告(损坏/截断)→ no-op,不抛、不写', async () => {
    // 报告只含 round-0/round-1,却传 bestRound=2 → winnerVariant=round-2 不在 summary。守卫应 no-op,
    // 而非让 winnerVerdict→computeVerdict 读 undefined 抛错。正常 evolve 产物不会这样,这是损坏边角防御。
    writeRecord();
    const out = await recordEvolveOutcome({
      reportId: 'evolve-review-abc123', bestRound: 2,
      skillPath, skillDir: dirname(skillPath), isDirectorySkill: false, dir, loadReport: load(),
    });
    assert.equal(out, null, '缺胜出轮 → no-op');
    assert.equal(loadRec().evidence.length, 0, '不写证据');
    assert.equal(loadRec().contentHash, oldHash, '不 re-baseline');
  });

  it('git 源记录 → 不匹配(evolve 只动本地源,git 记录 sourceKind≠file)', async () => {
    writeRecord({ source: { sourceKind: 'git', locator: 'git:HEAD:skills/review', isDirectorySkill: false } });
    const out = await recordEvolveOutcome({
      reportId: 'evolve-review-abc123', bestRound: 1,
      skillPath, skillDir: dirname(skillPath), isDirectorySkill: false, dir, loadReport: load(),
    });
    assert.equal(out, null, 'git 源记录不应被本地 evolve 命中');
    assert.equal(loadRec().evidence.length, 0, '不写证据');
  });
});
