import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { extractWeakSamples, buildImprovementPrompt, evolveSkill, allNonTripwireAssertionsPass, splitTrainValTest, restrictReportToSamples, decideAccept, computeEditDelta, agentSampleEditWithinScope } from '../../src/authoring/evolver.js';
import { fixSamples } from '../../src/authoring/sample-fixer.js';
import type { Report, EvaluationReport } from '../../src/types/index.js';

function toReport(value: unknown): Report {
  return value as Report;
}

describe('extractWeakSamples', () => {
  const mockReport = {
    results: [
      { sample_id: 's001', variants: { skill: { compositeScore: 4.5, llmReason: 'Good', assertions: { details: [{ type: 'contains', value: 'SQL', passed: true }] } } } },
      { sample_id: 's002', variants: { skill: { compositeScore: 2.0, llmReason: 'Missing key points', assertions: { details: [{ type: 'contains', value: 'error', passed: false }] } } } },
      { sample_id: 's003', variants: { skill: { compositeScore: 3.0, llmReason: 'Partial', assertions: { details: [] }, dimensions: { security: { score: 3 }, actionability: { score: 4 } } } } },
    ],
  };

  it('returns samples sorted by score ascending', () => {
    const weak = extractWeakSamples(toReport(mockReport), 'skill');
    assert.equal(weak[0].sample_id, 's002');
    assert.equal(weak[1].sample_id, 's003');
    assert.equal(weak[2].sample_id, 's001');
  });

  it('respects count limit', () => {
    const weak = extractWeakSamples(toReport(mockReport), 'skill', 2);
    assert.equal(weak.length, 2);
  });

  it('includes failed assertions', () => {
    const weak = extractWeakSamples(toReport(mockReport), 'skill');
    assert.equal(weak[0].failedAssertions.length, 1);
    assert.ok(weak[0].failedAssertions[0].includes('contains'));
  });

  it('includes dimension scores', () => {
    const weak = extractWeakSamples(toReport(mockReport), 'skill');
    const s003 = weak.find((s: { sample_id: string }) => s.sample_id === 's003');
    assert.equal(s003!.dimensions!.security, 3);
    assert.equal(s003!.dimensions!.actionability, 4);
  });

  it('restricts to the train split when a sampleIdFilter is given (holdout leak guard)', () => {
    // s002 is the weakest but lives in the holdout split — it must NOT surface as a
    // weak sample, otherwise the improvement prompt would tune the skill to holdout.
    const trainIds = new Set(['s001', 's003']);
    const weak = extractWeakSamples(toReport(mockReport), 'skill', 5, trainIds);
    assert.deepEqual(weak.map((s) => s.sample_id), ['s003', 's001']);
    assert.ok(!weak.some((s) => s.sample_id === 's002'));
  });
});

describe('splitTrainValTest', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}`);

  it('returns null when either ratio is 0 (off / no test)', () => {
    assert.equal(splitTrainValTest(ids(30), 0, 0.2), null);
    assert.equal(splitTrainValTest(ids(30), 0.2, 0), null);
  });

  it('returns null when any of the three sides falls below the minimum subset', () => {
    // N=10, val 0.2 → 2 < 3 → disabled.
    assert.equal(splitTrainValTest(ids(10), 0.2, 0.2), null);
    // N=12, val 0.4 (5), test 0.4 (5) → train 2 < 3 → disabled.
    assert.equal(splitTrainValTest(ids(12), 0.4, 0.4), null);
  });

  it('carves three disjoint, exhaustive sets at an even stride', () => {
    const split = splitTrainValTest(ids(20), 0.2, 0.2);
    assert.ok(split);
    assert.equal(split!.valIds.size, 4);
    assert.equal(split!.testIds.size, 4);
    assert.equal(split!.trainIds.size, 12);
    // Pairwise disjoint.
    for (const id of split!.valIds) {
      assert.ok(!split!.testIds.has(id));
      assert.ok(!split!.trainIds.has(id));
    }
    for (const id of split!.testIds) assert.ok(!split!.trainIds.has(id));
    // Exhaustive.
    assert.equal(split!.valIds.size + split!.testIds.size + split!.trainIds.size, 20);
  });

  it('is deterministic across calls (stable split, no RNG)', () => {
    const a = splitTrainValTest(ids(23), 0.25, 0.25);
    const b = splitTrainValTest(ids(23), 0.25, 0.25);
    assert.deepEqual([...a!.valIds], [...b!.valIds]);
    assert.deepEqual([...a!.testIds], [...b!.testIds]);
  });
});

describe('restrictReportToSamples (holdout leak guard)', () => {
  it('keeps only results whose sample_id is in the set', () => {
    const report = toReport({
      results: [
        { sample_id: 's1', variants: {} },
        { sample_id: 's2', variants: {} },
        { sample_id: 's3', variants: {} },
      ],
    });
    const out = restrictReportToSamples(report, new Set(['s1', 's3']));
    assert.deepEqual(out.results.map((r) => r.sample_id), ['s1', 's3']);
  });
});

describe('auto-fix-samples respects the holdout split', () => {
  // Both modes (agent / rewrite) iterate the same `report.results`; evolveSkill now
  // hands the fixer a train-restricted report, so a holdout sample can never enter the
  // fix prompt nor be rewritten. This exercises the rewrite path end-to-end (injectable
  // executor) — the strongest place to prove the leak guard.
  it('a holdout sample never enters the sample-fix prompt (rewrite mode)', async () => {
    const failVariant = { ok: true, compositeScore: 2, assertions: { details: [{ type: 'contains', value: 'x', passed: false }] } };
    const fullReport = toReport({
      results: [
        { sample_id: 's_train', variants: { skill: failVariant } },
        { sample_id: 's_hold', variants: { skill: failVariant } },
      ],
    });
    const samples: Record<string, unknown>[] = [
      { sample_id: 's_train', prompt: 'p', assertions: [] },
      { sample_id: 's_hold', prompt: 'p', assertions: [] },
    ];
    let capturedPrompt = '';
    const mockExecutor: Parameters<typeof fixSamples>[0]['executor'] = async (o) => {
      capturedPrompt += o.prompt;
      return { ok: true, text: '[]', costUSD: 0 };
    };
    await fixSamples({
      skillContent: 'skill',
      samples,
      // What evolveSkill passes under an active holdout: only training-split results.
      report: restrictReportToSamples(fullReport, new Set(['s_train'])) as unknown as EvaluationReport,
      treatmentKey: 'skill',
      executor: mockExecutor,
      model: 'm',
    });
    assert.match(capturedPrompt, /s_train/);
    assert.doesNotMatch(capturedPrompt, /s_hold/);
  });
});

describe('agent sample-fix field boundary', () => {
  const original = {
    sample_id: 's1',
    prompt: 'do the work',
    assertions: [{ type: 'contains', value: 'done' }],
    omkFix: { attempts: 1, lastReportId: 'r1' },
  };

  it('allows only the declared fixable fields', () => {
    assert.equal(agentSampleEditWithinScope(original, {
      ...original,
      assertions: [{ type: 'contains', value: 'result' }],
      environment: { notes: 'fixture is ready' },
    }), true);
    assert.equal(agentSampleEditWithinScope(original, {
      ...original,
      prompt: 'changed intent',
    }), false);
  });

  it('rejects agent-authored omkFix metadata', () => {
    assert.equal(agentSampleEditWithinScope(original, {
      ...original,
      omkFix: { attempts: 99, lastReportId: 'forged' },
    }), false);
  });
});

describe('buildImprovementPrompt', () => {
  it('includes skill content and score', () => {
    const prompt = buildImprovementPrompt('你是一个助手', 3.5, []);
    assert.ok(prompt.includes('你是一个助手'));
    assert.ok(prompt.includes('3.50'));
  });

  it('includes weak sample details', () => {
    const weakSamples = [
      { sample_id: 's001', compositeScore: 2.0, llmReason: 'Missing analysis', failedAssertions: ['contains: SQL'], dimensions: null },
    ];
    const prompt = buildImprovementPrompt('test skill', 3.0, weakSamples);
    assert.ok(prompt.includes('s001'));
    assert.ok(prompt.includes('2/5.0'));
    assert.ok(prompt.includes('Missing analysis'));
    assert.ok(prompt.includes('contains: SQL'));
  });

  it('appends the rejected-edit memory section when given, omits it when empty', () => {
    const withMemory = buildImprovementPrompt('skill', 3.0, [], ['【第 2 轮被拒（提升不显著）】\n+ 加了一句废话']);
    assert.match(withMemory, /已试过且未带来显著提升的改法/);
    assert.match(withMemory, /加了一句废话/);
    const without = buildImprovementPrompt('skill', 3.0, [], []);
    assert.doesNotMatch(without, /已试过且未带来显著提升/);
    const undef = buildImprovementPrompt('skill', 3.0, []);
    assert.doesNotMatch(undef, /已试过且未带来显著提升/);
  });
});

describe('computeEditDelta (edit budget)', () => {
  it('reports zero change for identical content', () => {
    const d = computeEditDelta('a\nb\nc', 'a\nb\nc');
    assert.equal(d.changedLines, 0);
    assert.equal(d.ratio, 0);
  });

  it('counts added + removed unique non-empty lines, ratio over original line count', () => {
    // before 4 lines; remove "b", add "x" and "y" → 1 removed + 2 added = 3 changed / 4.
    const d = computeEditDelta('a\nb\nc\nd', 'a\nc\nd\nx\ny');
    assert.equal(d.changedLines, 3);
    assert.equal(d.ratio, 3 / 4);
    assert.match(d.summary, /\+ x/);
    assert.match(d.summary, /- b/);
  });

  it('ignores whitespace-only differences (trimmed, empty-filtered)', () => {
    const d = computeEditDelta('a\nb', '  a  \n\n b ');
    assert.equal(d.changedLines, 0);
  });

  it('truncates the summary past maxSummaryLines', () => {
    const before = 'k';
    const after = ['k', ...Array.from({ length: 20 }, (_, i) => `add${i}`)].join('\n');
    const d = computeEditDelta(before, after, 5);
    assert.match(d.summary, /其余 \+15 行/);
  });
});

describe('allNonTripwireAssertionsPass', () => {
  it('returns true when all normal samples pass assertions', () => {
    const report = toReport({
      sampleSnapshots: { s2: { tripwire: true } },
      results: [
        { sample_id: 's1', variants: { skill: { ok: true, assertions: { details: [{ passed: true }] } } } },
        { sample_id: 's2', variants: { skill: { ok: true, assertions: { details: [{ passed: false }] } } } },
      ],
    });
    assert.equal(allNonTripwireAssertionsPass(report, 'skill'), true);
  });

  it('returns false when a normal sample fails an assertion', () => {
    const report = toReport({
      results: [
        { sample_id: 's1', variants: { skill: { ok: true, assertions: { details: [{ passed: false }] } } } },
      ],
    });
    assert.equal(allNonTripwireAssertionsPass(report, 'skill'), false);
  });

  it('returns false when any sample has an execution error', () => {
    const report = toReport({
      sampleSnapshots: { s1: { tripwire: true } },
      results: [
        { sample_id: 's1', variants: { skill: { ok: false, assertions: { details: [{ passed: false }] } } } },
      ],
    });
    assert.equal(allNonTripwireAssertionsPass(report, 'skill'), false);
  });

  it('treats diagnostic tripwire_intentional as a tripwire sample', () => {
    const report = toReport({
      results: [
        { sample_id: 's1', variants: { skill: { ok: true, diagnostic: { rootCause: ['tripwire_intentional'] }, assertions: { details: [{ passed: false }] } } } },
      ],
    });
    assert.equal(allNonTripwireAssertionsPass(report, 'skill'), true);
  });
});

describe('decideAccept (significance gate)', () => {
  const fill = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
  const GATE = { significanceGate: true, alpha: 0.05, seed: 42 };
  const OFF = { significanceGate: false, alpha: 0.05, seed: 42 };

  it('THE core difference: a noise-only gain is accepted by the old point estimate but REJECTED by the gate', () => {
    // Best is flat 3.0; candidate is mostly 3.0 with a couple of higher samples — its
    // mean edges above best, but the improvement is indistinguishable from noise.
    const best = fill(3.0, 20);
    const cand = [...fill(3.0, 18), 3.5, 3.5];
    const pointBest = 3.0;
    const pointCand = cand.reduce((a, b) => a + b, 0) / cand.length; // 3.05 > 3.0

    // Old behavior (gate off): point estimate accepts.
    assert.equal(decideAccept(best, cand, pointBest, pointCand, OFF).accepted, true);
    // New behavior (gate on): not significant → rejected. This is the PR's whole point.
    const gated = decideAccept(best, cand, pointBest, pointCand, GATE);
    assert.equal(gated.accepted, false);
    assert.equal(gated.diffCI!.significant, false);
    assert.equal(gated.underpowered, false);
  });

  it('accepts a clearly significant improvement', () => {
    const best = fill(2.0, 20);
    const cand = fill(4.0, 20);
    const d = decideAccept(best, cand, 2.0, 4.0, GATE);
    assert.equal(d.accepted, true);
    assert.equal(d.diffCI!.significant, true);
    assert.ok(d.diffCI!.estimate > 0);
  });

  it('rejects a significant REGRESSION even though the gate fired', () => {
    const best = fill(4.0, 20);
    const cand = fill(2.0, 20);
    const d = decideAccept(best, cand, 4.0, 2.0, GATE);
    assert.equal(d.accepted, false); // significant but estimate < 0
  });

  it('does NOT overwrite a higher recorded best when the fresh re-eval is noise-low (monotonic guard)', () => {
    // P1: the current best re-evaluated noise-low (2.0); the candidate (3.0) is
    // significantly above THAT re-eval, but the recorded best was 4.0 — accepting would
    // downgrade best. The diff is genuinely significant and positive, yet pointCand <
    // pointBest must block acceptance so bestScore never decreases.
    const best = fill(2.0, 20);
    const cand = fill(3.0, 20);
    const d = decideAccept(best, cand, 4.0, 3.0, GATE);
    assert.equal(d.accepted, false);
    assert.equal(d.diffCI!.significant, true);
    assert.ok(d.diffCI!.estimate > 0);
  });

  it('degrades to the point estimate (and flags underpowered) below the sample floor', () => {
    const best = fill(3.0, 5);
    const cand = fill(4.0, 5);
    const d = decideAccept(best, cand, 3.0, 4.0, GATE);
    assert.equal(d.accepted, true); // point estimate: 4 > 3
    assert.equal(d.underpowered, true);
    assert.equal(d.diffCI, undefined);
  });

  it('is deterministic for a fixed seed', () => {
    const best = fill(3.0, 20);
    const cand = [...fill(3.0, 16), 3.5, 3.5, 3.5, 3.5];
    const a = decideAccept(best, cand, 3.0, 3.1, GATE);
    const b = decideAccept(best, cand, 3.0, 3.1, GATE);
    assert.deepEqual(a.diffCI, b.diffCI);
  });
});

describe('evolveSkill', () => {
  it('is a function', () => {
    assert.equal(typeof evolveSkill, 'function');
  });
});
