import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  extractJson,
  parseHealthOutput,
  deriveOverallHealth,
} from '../../../src/doctor/health/parser.js';
import type { HealthDimensionSpec } from '../../../src/doctor/health/dimension-spec.js';

const stubDim = (id: string): HealthDimensionSpec => ({
  id,
  displayName: id,
  labelKey: `cli.doctor.health.dim.${id}`,
  severity: 'warn',
  promptSection: `${id} prompt`,
});

const dims = [stubDim('a'), stubDim('b'), stubDim('c')];

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

describe('extractJson', () => {
  it('returns null on empty', () => {
    assert.equal(extractJson(''), null);
  });

  it('extracts a single object with prose preamble', () => {
    const text = 'Here:\n{"skill_name":"x","checklist":[],"summary":{}}\nThanks!';
    const out = extractJson(text);
    assert.ok(out);
    assert.equal(JSON.parse(out!).skill_name, 'x');
  });

  it('prefers candidate with ≥2 required keys', () => {
    const text = '{"sub":{"k":1}} {"skill_name":"x","checklist":[],"summary":{"overall_health":"良好"}}';
    const out = extractJson(text);
    assert.equal(JSON.parse(out!).skill_name, 'x');
  });

  it('handles braces inside strings', () => {
    const text = '{"skill_name":"x","note":"contains } brace","checklist":[],"summary":{}}';
    assert.equal(JSON.parse(extractJson(text)!).note, 'contains } brace');
  });

  it('handles escaped quotes', () => {
    const text = '{"skill_name":"x","note":"with \\"quote\\"","checklist":[],"summary":{}}';
    assert.equal(JSON.parse(extractJson(text)!).note, 'with "quote"');
  });

  it('returns null if no parseable object', () => {
    assert.equal(extractJson('not JSON'), null);
    assert.equal(extractJson('{ unclosed '), null);
  });
});

// ---------------------------------------------------------------------------
// parseHealthOutput
// ---------------------------------------------------------------------------

describe('parseHealthOutput', () => {
  it('dispatches checklist items to byDimId by dim_id', () => {
    const json = JSON.stringify({
      skill_name: 'x',
      checklist: [
        { dim_id: 'a', level: '健康', findings: [], suggestions: [] },
        { dim_id: 'b', level: '亚健康', findings: [{ level: '警告', evidence: 'L1', description: 'd' }], suggestions: ['fix'] },
        { dim_id: 'c', level: '不健康', findings: [{ level: '错误', evidence: 'L2', description: 'd2' }], suggestions: [] },
      ],
      summary: { overall_health: '严重缺陷', top_suggestions: ['top1'] },
    });
    const r = parseHealthOutput(json, dims);
    assert.equal(r.byDimId.size, 3);
    assert.equal(r.byDimId.get('a')!.level, '健康');
    assert.equal(r.byDimId.get('b')!.findings.length, 1);
    assert.equal(r.byDimId.get('c')!.level, '不健康');
    assert.equal(r.overall, '严重缺陷');
    assert.deepEqual(r.topSuggestions, ['top1']);
  });

  it('drops checklist items with unknown dim_id', () => {
    const json = JSON.stringify({
      skill_name: 'x',
      checklist: [
        { dim_id: 'a', level: '健康', findings: [], suggestions: [] },
        { dim_id: 'unknown-id', level: '健康', findings: [], suggestions: [] },
      ],
      summary: {},
    });
    const r = parseHealthOutput(json, dims);
    assert.equal(r.byDimId.size, 3); // a + b/c missing placeholders, but unknown-id dropped
    assert.ok(!r.byDimId.has('unknown-id'));
  });

  it('fills missing dimensions with placeholder marked _missing', () => {
    const json = JSON.stringify({
      skill_name: 'x',
      checklist: [{ dim_id: 'a', level: '健康', findings: [], suggestions: [] }],
      summary: {},
    });
    const r = parseHealthOutput(json, dims);
    assert.equal(r.byDimId.get('a')!._missing, undefined);
    assert.equal(r.byDimId.get('b')!._missing, true);
    assert.equal(r.byDimId.get('c')!._missing, true);
  });

  it('derives level from findings when item.level is missing/invalid', () => {
    const json = JSON.stringify({
      skill_name: 'x',
      checklist: [
        { dim_id: 'a', findings: [], suggestions: [] }, // missing level → 健康 (0 findings)
        { dim_id: 'b', level: 'wat', findings: [{ level: '警告', evidence: 'e', description: 'd' }], suggestions: [] },
        { dim_id: 'c', findings: [{ level: '错误', evidence: 'e', description: 'd' }], suggestions: [] },
      ],
      summary: {},
    });
    const r = parseHealthOutput(json, dims);
    assert.equal(r.byDimId.get('a')!.level, '健康');
    assert.equal(r.byDimId.get('b')!.level, '亚健康');
    assert.equal(r.byDimId.get('c')!.level, '不健康');
  });

  it('returns overall=null when LLM gave invalid value (caller derives)', () => {
    const json = JSON.stringify({
      skill_name: 'x',
      checklist: [{ dim_id: 'a', level: '健康', findings: [], suggestions: [] }],
      summary: { overall_health: 'wat' },
    });
    const r = parseHealthOutput(json, dims);
    assert.equal(r.overall, null);
  });

  it('preserves feature_points', () => {
    const fp = [{ name: 'fp1', simulation: [] }];
    const json = JSON.stringify({ skill_name: 'x', feature_points: fp, checklist: [], summary: {} });
    const r = parseHealthOutput(json, dims);
    assert.deepEqual(r.featurePoints, fp);
  });

  it('handles malformed JSON gracefully (returns empty results)', () => {
    const r = parseHealthOutput('not-json', dims);
    assert.equal(r.byDimId.size, 3); // all 3 placeholders
    assert.equal(r.byDimId.get('a')!._missing, true);
  });
});

// ---------------------------------------------------------------------------
// deriveOverallHealth
// ---------------------------------------------------------------------------

describe('deriveOverallHealth', () => {
  const buildMap = (entries: Array<[string, '健康' | '亚健康' | '不健康' | '不适用', boolean?]>) => {
    const m = new Map();
    for (const [id, level, missing] of entries) {
      m.set(id, { level, findings: [], suggestions: [], _missing: missing });
    }
    return m;
  };

  it('any 不健康 → 严重缺陷', () => {
    assert.equal(deriveOverallHealth(buildMap([['a', '不健康'], ['b', '健康']])), '严重缺陷');
  });
  it('only 亚健康 → 部分缺陷', () => {
    assert.equal(deriveOverallHealth(buildMap([['a', '亚健康'], ['b', '健康']])), '部分缺陷');
  });
  it('all 健康/不适用 → 良好', () => {
    assert.equal(deriveOverallHealth(buildMap([['a', '健康'], ['b', '不适用']])), '良好');
  });
  it('ignores _missing dims when deriving', () => {
    assert.equal(deriveOverallHealth(buildMap([['a', '不健康', true], ['b', '健康']])), '良好');
  });
});
