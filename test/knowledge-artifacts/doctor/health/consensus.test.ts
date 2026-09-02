import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  enumerateFindingsForMerge,
  findingKey,
  mergeHealthSamples,
  mergeHealthSamplesLlm,
  parseMergeClusters,
} from '../../../../src/knowledge-artifacts/doctor/health/consensus.js';
import type { HealthParseResult } from '../../../../src/knowledge-artifacts/doctor/health/parser.js';
import type {
  HealthDimensionResult,
  HealthDimensionSpec,
  HealthFinding,
  HealthFindingLevel,
} from '../../../../src/knowledge-artifacts/doctor/health/dimension-spec.js';

const dim = (id: string): HealthDimensionSpec => ({
  id,
  displayName: id,
  labelKey: `cli.doctor.health.dim.${id}`,
  severity: 'warn',
  promptSection: `${id} prompt`,
});

const f = (level: HealthFindingLevel, description: string, suggestion?: string): HealthFinding => ({
  level, subtype: '', evidence: '', description, suggestion,
});

const dimResult = (findings: HealthFinding[], opts: { missing?: boolean } = {}): HealthDimensionResult => ({
  level: findings.some((x) => x.level === '错误') ? '不健康' : findings.length ? '亚健康' : '健康',
  findings,
  suggestions: [],
  ...(opts.missing ? { _missing: true } : {}),
});

const sample = (entries: Record<string, HealthDimensionResult>): HealthParseResult => ({
  byDimId: new Map(Object.entries(entries)),
  overall: null,
  topSuggestions: [],
  featurePoints: [],
});

describe('findingKey', () => {
  it('anchors (backtick tokens) drive the key — wording can differ', () => {
    assert.equal(
      findingKey(f('警告', '缺少 `foo.sh` 脚本')),
      findingKey(f('错误', '`foo.sh` 引用的脚本不存在,换环境必失败')),
    );
  });

  it('anchor key is order-insensitive and deduped', () => {
    assert.equal(
      findingKey(f('警告', '`a.sh` 和 `b.sh` 都缺')),
      findingKey(f('警告', '`b.sh`、`a.sh` 缺失')),
    );
  });

  it('falls back to normalized description prefix when no anchor', () => {
    assert.equal(
      findingKey(f('警告', '缺少示例!')),
      findingKey(f('警告', '缺少示例')),
    );
    assert.notEqual(
      findingKey(f('警告', '缺少示例')),
      findingKey(f('警告', '路径不可移植')),
    );
  });
});

describe('mergeHealthSamples', () => {
  it('unions findings across samples and tags k/n support', () => {
    const dims = [dim('sec')];
    const s1 = sample({ sec: dimResult([f('警告', '缺少 `foo.sh`')]) });
    const s2 = sample({ sec: dimResult([f('警告', '`foo.sh` 引用不存在')]) });
    const merged = mergeHealthSamples([s1, s2], dims);
    const sec = merged.byDimId.get('sec')!;
    assert.equal(sec.findings.length, 1, '同锚点应合并成一条');
    assert.deepEqual(sec.findings[0].support, { k: 2, n: 2 });
  });

  it('keeps low-support findings (no filtering) with k<n', () => {
    const dims = [dim('sec')];
    const s1 = sample({ sec: dimResult([f('警告', '缺少 `foo.sh`')]) });
    const s2 = sample({ sec: dimResult([]) }); // present, healthy
    const merged = mergeHealthSamples([s1, s2], dims);
    const sec = merged.byDimId.get('sec')!;
    assert.equal(sec.findings.length, 1);
    assert.deepEqual(sec.findings[0].support, { k: 1, n: 2 }, '只在 1/2 次出现,但仍保留');
  });

  it('cross-sample level drift merges to the most severe', () => {
    const dims = [dim('sec')];
    const s1 = sample({ sec: dimResult([f('警告', '`foo.sh` 缺')]) });
    const s2 = sample({ sec: dimResult([f('错误', '`foo.sh` 缺失,必失败')]) });
    const merged = mergeHealthSamples([s1, s2], dims);
    const sec = merged.byDimId.get('sec')!;
    assert.equal(sec.findings[0].level, '错误');
    assert.equal(sec.level, '不健康');
  });

  it('n counts only samples where the dim was assessed (present, non-missing)', () => {
    const dims = [dim('a')];
    const s1 = sample({ a: dimResult([f('警告', '缺少 `x.sh`')]) });
    const s2 = sample({ a: dimResult([], { missing: true }) }); // omitted by LLM
    const merged = mergeHealthSamples([s1, s2], dims);
    const a = merged.byDimId.get('a')!;
    assert.equal(a._missing, undefined, '至少一次评估过 → 不算 missing');
    assert.deepEqual(a.findings[0].support, { k: 1, n: 1 }, 'n 只数被评估的那 1 次');
  });

  it('dim missing in ALL samples stays _missing', () => {
    const dims = [dim('a'), dim('b')];
    const s1 = sample({ a: dimResult([f('警告', '问题')]), b: dimResult([], { missing: true }) });
    const s2 = sample({ a: dimResult([]), b: dimResult([], { missing: true }) });
    const merged = mergeHealthSamples([s1, s2], dims);
    assert.equal(merged.byDimId.get('b')!._missing, true);
  });

  it('preserves 不适用 only when every present sample declares it', () => {
    const dims = [dim('na'), dim('mixed')];
    const naAll1 = sample({
      na: { level: '不适用', findings: [], suggestions: [] },
      mixed: { level: '不适用', findings: [], suggestions: [] },
    });
    const naAll2 = sample({
      na: { level: '不适用', findings: [], suggestions: [] },
      mixed: { level: '健康', findings: [], suggestions: [] }, // 一次判健康 → 适用
    });
    const merged = mergeHealthSamples([naAll1, naAll2], dims);
    assert.equal(merged.byDimId.get('na')!.level, '不适用');
    assert.equal(merged.byDimId.get('mixed')!.level, '健康');
  });

  it('single sample is identity + support {1,1}', () => {
    const dims = [dim('a')];
    const s1 = sample({ a: dimResult([f('错误', '`x` 缺失')]) });
    const merged = mergeHealthSamples([s1], dims);
    assert.deepEqual(merged.byDimId.get('a')!.findings[0].support, { k: 1, n: 1 });
  });

  it('string merge does NOT merge same root cause with different anchors (the gap llm fixes)', () => {
    const dims = [dim('dep')];
    const s1 = sample({ dep: dimResult([f('错误', '模板 `t1.tmpl.md` 缺失')]) });
    const s2 = sample({ dep: dimResult([f('错误', '模板 `t2.tmpl.md` 不存在')]) });
    const merged = mergeHealthSamples([s1, s2], dims);
    // 锚点不同(t1 vs t2)→ 字符串键不合并 → 2 条各 1/2
    assert.equal(merged.byDimId.get('dep')!.findings.length, 2);
  });
});

describe('parseMergeClusters', () => {
  it('parses valid clusters', () => {
    const out = parseMergeClusters(JSON.stringify({
      clusters: [
        { dim_id: 'dep', finding_ids: ['f0', 'f1'], level: '错误', description: '模板缺失', suggestion: '补' },
      ],
    }));
    assert.ok(out);
    assert.equal(out!.length, 1);
    assert.deepEqual(out![0].findingIds, ['f0', 'f1']);
    assert.equal(out![0].level, '错误');
  });

  it('returns null on missing/empty clusters or bad JSON', () => {
    assert.equal(parseMergeClusters('not json'), null);
    assert.equal(parseMergeClusters(JSON.stringify({})), null);
    assert.equal(parseMergeClusters(JSON.stringify({ clusters: [] })), null);
    assert.equal(parseMergeClusters(JSON.stringify({ clusters: [{ dim_id: 'x' }] })), null); // 无 finding_ids
  });

  it('drops invalid level but keeps the cluster', () => {
    const out = parseMergeClusters(JSON.stringify({ clusters: [{ dim_id: 'dep', finding_ids: ['f0'], level: 'BOGUS' }] }));
    assert.equal(out![0].level, undefined);
  });
});

describe('mergeHealthSamplesLlm', () => {
  const dims = [dim('dep')];
  const s1 = sample({ dep: dimResult([f('警告', '模板 `t1.tmpl.md` 缺失')]) });
  const s2 = sample({ dep: dimResult([f('错误', '模板 `t2.tmpl.md` 不存在')]) });

  it('merges cross-wording findings into one via clusters (2/2)', () => {
    const tagged = enumerateFindingsForMerge([s1, s2], dims);
    assert.equal(tagged.length, 2);
    const clusters = parseMergeClusters(JSON.stringify({
      clusters: [{ dim_id: 'dep', finding_ids: tagged.map((t) => t.id), level: '错误', description: '模板目录缺失', suggestion: '补 templates' }],
    }))!;
    const merged = mergeHealthSamplesLlm([s1, s2], dims, tagged, clusters);
    const dep = merged.byDimId.get('dep')!;
    assert.equal(dep.findings.length, 1, '跨措辞合并成一条');
    assert.deepEqual(dep.findings[0].support, { k: 2, n: 2 });
    assert.equal(dep.findings[0].level, '错误', 'override level');
    assert.equal(dep.findings[0].description, '模板目录缺失', 'override description');
    assert.equal(dep.level, '不健康');
  });

  it('uncovered findings fall back to singleton groups (never dropped)', () => {
    const tagged = enumerateFindingsForMerge([s1, s2], dims);
    // cluster 只覆盖第一个 → 第二个兜底成单元素组
    const clusters = parseMergeClusters(JSON.stringify({
      clusters: [{ dim_id: 'dep', finding_ids: [tagged[0].id], level: '警告', description: 'x' }],
    }))!;
    const merged = mergeHealthSamplesLlm([s1, s2], dims, tagged, clusters);
    assert.equal(merged.byDimId.get('dep')!.findings.length, 2, '没丢 finding');
  });

  it('ignores finding_ids assigned to the wrong dim', () => {
    const dims2 = [dim('dep'), dim('sec')];
    const a = sample({ dep: dimResult([f('错误', '`x` 缺失')]), sec: dimResult([f('警告', '`y` 风险')]) });
    const tagged = enumerateFindingsForMerge([a], dims2);
    // 故意把 sec 的 finding 塞进 dep 的 cluster → 应被忽略,sec finding 兜底保留
    const depId = tagged.find((t) => t.dimId === 'dep')!.id;
    const secId = tagged.find((t) => t.dimId === 'sec')!.id;
    const clusters = parseMergeClusters(JSON.stringify({
      clusters: [{ dim_id: 'dep', finding_ids: [depId, secId] }],
    }))!;
    const merged = mergeHealthSamplesLlm([a], dims2, tagged, clusters);
    assert.equal(merged.byDimId.get('dep')!.findings.length, 1);
    assert.equal(merged.byDimId.get('sec')!.findings.length, 1, 'sec finding 没被跨维度吞掉');
  });
});

describe('consensus — CR regression', () => {
  it('llm override level can RAISE but never LOWER below member worst', () => {
    const dims = [dim('dep')];
    // member 是 错误,override 说 警告 → 不得降级,保持 错误
    const s1 = sample({ dep: dimResult([f('错误', '`x` 缺失,必失败')]) });
    const tagged = enumerateFindingsForMerge([s1], dims);
    const down = parseMergeClusters(JSON.stringify({
      clusters: [{ dim_id: 'dep', finding_ids: tagged.map((t) => t.id), level: '警告', description: 'x' }],
    }))!;
    const m1 = mergeHealthSamplesLlm([s1], dims, tagged, down);
    assert.equal(m1.byDimId.get('dep')!.findings[0].level, '错误', 'override 不能把 错误 降成 警告');
    assert.equal(m1.byDimId.get('dep')!.level, '不健康');

    // member 是 警告,override 说 错误 → 可以升级
    const s2 = sample({ dep: dimResult([f('警告', '`y` 可能有问题')]) });
    const tagged2 = enumerateFindingsForMerge([s2], dims);
    const up = parseMergeClusters(JSON.stringify({
      clusters: [{ dim_id: 'dep', finding_ids: tagged2.map((t) => t.id), level: '错误', description: 'y' }],
    }))!;
    const m2 = mergeHealthSamplesLlm([s2], dims, tagged2, up);
    assert.equal(m2.byDimId.get('dep')!.findings[0].level, '错误', 'override 可以升级到 错误');
  });

  it('support n excludes 不适用 samples (denominator = assessed & applicable)', () => {
    const dims = [dim('a')];
    const s1 = sample({ a: dimResult([f('错误', '`x` 缺失')]) });
    const s2 = sample({ a: { level: '不适用', findings: [], suggestions: [] } });
    const merged = mergeHealthSamples([s1, s2], dims);
    // 一次适用并报了、另一次判不适用 → n=1(不是 2),k=1
    assert.deepEqual(merged.byDimId.get('a')!.findings[0].support, { k: 1, n: 1 });
  });

  it('a finding_id claimed by two clusters lands in the first only (no double-count)', () => {
    const dims = [dim('dep')];
    const s1 = sample({ dep: dimResult([f('错误', '`a` 缺失'), f('警告', '`b` 风险')]) });
    const tagged = enumerateFindingsForMerge([s1], dims); // f0, f1
    const clusters = parseMergeClusters(JSON.stringify({
      clusters: [
        { dim_id: 'dep', finding_ids: ['f0'], level: '错误', description: 'first' },
        { dim_id: 'dep', finding_ids: ['f0', 'f1'], level: '警告', description: 'second' },
      ],
    }))!;
    const findings = mergeHealthSamplesLlm([s1], dims, tagged, clusters).byDimId.get('dep')!.findings;
    assert.equal(findings.length, 2, 'f0 只进第一个 cluster,f1 进第二个 → 2 条,无重复');
    assert.deepEqual(findings.map((x) => x.support!.k).sort(), [1, 1], 'f0 没被两组都计入 k');
  });

  it('cluster with blank description falls back to representative finding text', () => {
    const dims = [dim('dep')];
    const s1 = sample({ dep: dimResult([f('错误', '原始描述 `x`')]) });
    const tagged = enumerateFindingsForMerge([s1], dims);
    const clusters = parseMergeClusters(JSON.stringify({
      clusters: [{ dim_id: 'dep', finding_ids: tagged.map((t) => t.id), level: '错误', description: '   ' }],
    }))!;
    const merged = mergeHealthSamplesLlm([s1], dims, tagged, clusters);
    assert.equal(merged.byDimId.get('dep')!.findings[0].description, '原始描述 `x`', '空 description 回退 rep');
  });
});
