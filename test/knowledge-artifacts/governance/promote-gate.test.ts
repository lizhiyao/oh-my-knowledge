/**
 * promote 证据门禁纯函数单测：Core readiness、drift、no-evidence、verdict、PROGRESS 放行与
 * acceptCautious。门禁是「值得 ship」的判定核心，默认严格
 * (仅 PROGRESS),这层判据一旦走样会让不该 ship 的版本被接受却测不出来。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { evaluatePromoteGate } from '../../../src/knowledge-artifacts/governance/promote-gate.js';
import type { ManagedArtifactRecord, ManagedEvidenceRef } from '../../../src/knowledge-artifacts/governance/contracts.js';
import { coreManagedEvidence } from '../../helpers/core-managed-evidence.js';

const CUR = 'HASH_CUR';

function rec(over: Partial<ManagedArtifactRecord> = {}): ManagedArtifactRecord {
  return {
    recordKind: 'managed-artifact', schemaVersion: 3, id: 'id', name: 'review', kind: 'skill',
    source: { sourceKind: 'file', locator: '/abs/review', isDirectorySkill: false },
    contentHash: CUR, installedAt: '2026-06-06T00:00:00.000Z',
    distribution: [], evidence: [], decisions: [], ...over,
  };
}
function ev(over: Partial<ManagedEvidenceRef> = {}): ManagedEvidenceRef {
  return coreManagedEvidence(CUR, { reportId: 'r1', recordedAt: '2026-06-07T00:00:00.000Z', ...over });
}

describe('evaluatePromoteGate', () => {
  it('PROGRESS + 可比 + 不漂 → 通过,带回证据', () => {
    const g = evaluatePromoteGate({ record: rec({ evidence: [ev()] }), currentContentHash: CUR });
    assert.equal(g.ok, true);
    assert.deepEqual(g.blocked, []);
    assert.equal(g.evidence?.reportId, 'r1');
    assert.equal(g.drifted, false);
  });

  it('drift:当前源 hash 不等 → drifted 拦截', () => {
    const g = evaluatePromoteGate({ record: rec({ evidence: [ev()] }), currentContentHash: 'OTHER' });
    assert.equal(g.ok, false);
    assert.ok(g.blocked.some((b) => b.blockKind === 'drifted'));
    assert.equal(g.drifted, true);
  });

  it('drift:源不可达(currentContentHash undefined)→ drifted 拦截', () => {
    const g = evaluatePromoteGate({ record: rec({ evidence: [ev()] }), currentContentHash: undefined });
    assert.ok(g.blocked.some((b) => b.blockKind === 'drifted'));
  });

  it('无当前证据 → no_current_evidence 终态,evidence 为空(force 也越不过)', () => {
    const g = evaluatePromoteGate({ record: rec({ evidence: [] }), currentContentHash: CUR });
    assert.equal(g.ok, false);
    assert.ok(g.blocked.some((b) => b.blockKind === 'no_current_evidence'));
    assert.equal(g.evidence, undefined, '无证据无锚定 → force 不可越');
    // 提前收:不再追加 verdict / 可比性拦截。
    assert.equal(g.blocked.length, 1);
  });

  it('旧内容的证据不算当前证据 → no_current_evidence', () => {
    const g = evaluatePromoteGate({ record: rec({ evidence: [ev({ contentHash: 'OLD' })] }), currentContentHash: CUR });
    assert.ok(g.blocked.some((b) => b.blockKind === 'no_current_evidence'));
  });

  it('insufficient Core 证据不可作为 promote 锚点', () => {
    const g = evaluatePromoteGate({
      record: rec({ evidence: [ev({ evidenceReadiness: 'insufficient' })] }),
      currentContentHash: CUR,
    });
    assert.deepEqual(g.blocked.map((block) => block.blockKind), ['no_current_evidence']);
    assert.equal(g.evidence, undefined);
  });

  it('verdict=NOISE → verdict_blocked,带回被拦 verdict', () => {
    const g = evaluatePromoteGate({ record: rec({ evidence: [ev({ verdict: 'NOISE' })] }), currentContentHash: CUR });
    assert.equal(g.ok, false);
    const vb = g.blocked.find((b) => b.blockKind === 'verdict_blocked');
    assert.equal(vb?.detail?.verdict, 'NOISE');
  });

  it('CAUTIOUS:默认拦,acceptCautious 放行', () => {
    const blocked = evaluatePromoteGate({ record: rec({ evidence: [ev({ verdict: 'CAUTIOUS' })] }), currentContentHash: CUR });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.blocked.some((b) => b.blockKind === 'verdict_blocked'));
    const ok = evaluatePromoteGate({ record: rec({ evidence: [ev({ verdict: 'CAUTIOUS' })] }), currentContentHash: CUR, acceptCautious: true });
    assert.equal(ok.ok, true);
  });

  it('acceptCautious 仍拒 NOISE(只放宽到 CAUTIOUS)', () => {
    const g = evaluatePromoteGate({ record: rec({ evidence: [ev({ verdict: 'NOISE' })] }), currentContentHash: CUR, acceptCautious: true });
    assert.equal(g.ok, false);
  });

  it('组合:drift + verdict 同时拦,各记一条', () => {
    const g = evaluatePromoteGate({ record: rec({ evidence: [ev({ verdict: 'REGRESS' })] }), currentContentHash: 'OTHER' });
    assert.ok(g.blocked.some((b) => b.blockKind === 'drifted'));
    assert.ok(g.blocked.some((b) => b.blockKind === 'verdict_blocked'));
    assert.equal(g.evidence?.verdict, 'REGRESS', '有证据 → force 可越');
  });

  it('取 recordedAt 最新的当前证据(旧 PROGRESS 不掩盖新 REGRESS)', () => {
    const g = evaluatePromoteGate({
      record: rec({ evidence: [ev({ recordedAt: '2026-06-01T00:00:00.000Z', verdict: 'PROGRESS' }), ev({ recordedAt: '2026-06-09T00:00:00.000Z', verdict: 'REGRESS' })] }),
      currentContentHash: CUR,
    });
    assert.equal(g.ok, false, '最新一条是 REGRESS → 拦');
    assert.equal(g.evidence?.verdict, 'REGRESS');
  });
});
