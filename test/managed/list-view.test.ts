/**
 * `omk list` 纯视图构造单测。state / verdict / 证据计数都从受管记录读时推导,当前源哈由调用方注入
 * (这里给 mock),与 IO 解耦。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildManagedListRow, buildManagedListRows } from '../../src/managed/list-view.js';
import type { ManagedArtifactRecord, ManagedEvidenceRef } from '../../src/types/index.js';

function rec(over: Partial<ManagedArtifactRecord> = {}): ManagedArtifactRecord {
  return {
    recordKind: 'managed-artifact',
    schemaVersion: 2,
    id: 'id-review',
    name: 'review',
    kind: 'skill',
    source: { sourceKind: 'file', locator: '/abs/review', isDirectorySkill: true },
    contentHash: 'hashAAA',
    installedAt: '2026-06-06T00:00:00.000Z',
    distribution: [{ label: 'Claude Code', path: '/x/review', contentHash: 'hashAAA', copiedAt: '2026-06-06T00:00:00.000Z' }],
    evidence: [],
    decisions: [],
    ...over,
  };
}

function ev(over: Partial<ManagedEvidenceRef> = {}): ManagedEvidenceRef {
  return { reportId: 'r1', contentHash: 'hashAAA', recordedAt: '2026-06-08T00:00:00.000Z', verdict: 'PROGRESS', comparability: { cliVersion: '0.35.0' }, ...over };
}

describe('buildManagedListRow', () => {
  const reach = (hash: string) => ({ reachable: true as const, hash });
  const unreach = { reachable: false as const };

  it('installed:无证据、源哈与记录一致 → installed,verdict —,证据 0/0', () => {
    const row = buildManagedListRow(rec(), reach('hashAAA'));
    assert.equal(row.state, 'installed');
    assert.equal(row.drifted, false);
    assert.equal(row.reachable, true);
    assert.equal(row.latestVerdict, undefined);
    assert.equal(row.currentEvidenceCount, 0);
    assert.equal(row.totalEvidenceCount, 0);
    assert.equal(row.distributionCount, 1);
  });

  it('measurable:有当前证据(同哈)→ measurable + 带 verdict/可比性,证据 1/1', () => {
    const row = buildManagedListRow(rec({ evidence: [ev()] }), reach('hashAAA'));
    assert.equal(row.state, 'measurable');
    assert.equal(row.latestVerdict, 'PROGRESS');
    assert.equal(row.comparability?.cliVersion, '0.35.0');
    assert.equal(row.currentEvidenceCount, 1);
    assert.equal(row.totalEvidenceCount, 1);
  });

  it('stale:reachable 且源哈漂移(≠ 记录)→ stale + drifted,旧证据仍计入 total 但不计 current', () => {
    const row = buildManagedListRow(rec({ evidence: [ev()] }), reach('hashDRIFTED'));
    assert.equal(row.state, 'stale');
    assert.equal(row.drifted, true);
    assert.equal(row.reachable, true);
    assert.equal(row.currentEvidenceCount, 1, '证据 contentHash 仍等于 record.contentHash');
    assert.equal(row.totalEvidenceCount, 1);
  });

  it('不可达 ≠ stale:probe.reachable=false → 按证据给 installed,drifted=false,reachable=false', () => {
    const row = buildManagedListRow(rec(), unreach);
    assert.equal(row.state, 'installed', '源不可达不当 stale —— 修 cwd-fragile 误报(CR P1)');
    assert.equal(row.drifted, false, '不可达不打 drift');
    assert.equal(row.reachable, false);
  });

  it('不可达 + 有当前证据 → measurable(不是 stale),reachable=false', () => {
    const row = buildManagedListRow(rec({ evidence: [ev()] }), unreach);
    assert.equal(row.state, 'measurable');
    assert.equal(row.drifted, false);
    assert.equal(row.reachable, false);
  });

  it('多条当前证据 → 取 recordedAt 最新那条的 verdict', () => {
    const row = buildManagedListRow(rec({
      evidence: [
        ev({ reportId: 'old', recordedAt: '2026-06-07T00:00:00.000Z', verdict: 'NOISE' }),
        ev({ reportId: 'new', recordedAt: '2026-06-09T00:00:00.000Z', verdict: 'PROGRESS' }),
      ],
    }), reach('hashAAA'));
    assert.equal(row.latestVerdict, 'PROGRESS');
    assert.equal(row.recordedAt, '2026-06-09T00:00:00.000Z');
    assert.equal(row.currentEvidenceCount, 2);
  });

  it('旧内容证据(哈不等)不计 current、不取其 verdict', () => {
    const row = buildManagedListRow(rec({
      evidence: [ev({ contentHash: 'hashOLD', verdict: 'REGRESS', recordedAt: '2026-06-10T00:00:00.000Z' })],
    }), reach('hashAAA'));
    assert.equal(row.currentEvidenceCount, 0);
    assert.equal(row.totalEvidenceCount, 1);
    assert.equal(row.latestVerdict, undefined, '旧内容证据不冒充当前 verdict');
    assert.equal(row.state, 'installed', '只有旧内容证据 → 当前无证据 → installed');
  });

  it('远端 git:sourceLabel 取 url', () => {
    const row = buildManagedListRow(rec({
      source: { sourceKind: 'git', locator: 'git+https://x/r.git@sha1:review', ref: 'sha1', url: 'https://x/r.git', isDirectorySkill: true },
    }), reach('hashAAA'));
    assert.equal(row.sourceKind, 'git');
    assert.equal(row.sourceLabel, 'https://x/r.git');
  });

  it('防御层:file 源即便混入 url(已被 validator 拒)→ sourceLabel 取 locator 不取 url(显示=被读路径)', () => {
    const row = buildManagedListRow(rec({
      source: { sourceKind: 'file', locator: '/abs/private.md', url: 'https://example.com/safe.git', isDirectorySkill: false } as ManagedArtifactRecord['source'],
    }), reach('hashAAA'));
    assert.equal(row.sourceLabel, '/abs/private.md', 'file 源永不显示 url —— 显示的就是 probe 实际读取的 locator');
  });
});

describe('buildManagedListRows', () => {
  it('按 name 排序', () => {
    const rows = buildManagedListRows(
      [rec({ id: 'b', name: 'lint' }), rec({ id: 'a', name: 'apply' }), rec({ id: 'c', name: 'review' })],
      () => ({ reachable: true, hash: 'hashAAA' }),
    );
    assert.deepEqual(rows.map((r) => r.name), ['apply', 'lint', 'review']);
  });

  it('probeOf 按记录分别探测:一致 → installed;不可达 → installed + reachable=false(非 stale)', () => {
    const rows = buildManagedListRows(
      [rec({ id: 'a', name: 'a', contentHash: 'h1' }), rec({ id: 'b', name: 'b', contentHash: 'h2' })],
      (r) => (r.name === 'a' ? { reachable: true, hash: 'h1' } : { reachable: false }),
    );
    const a = rows.find((r) => r.name === 'a')!;
    const b = rows.find((r) => r.name === 'b')!;
    assert.equal(a.state, 'installed');
    assert.equal(a.reachable, true);
    assert.equal(b.state, 'installed');
    assert.equal(b.reachable, false, '源不可达不误报 stale');
    assert.equal(b.drifted, false);
  });
});
