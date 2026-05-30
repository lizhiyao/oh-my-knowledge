import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { extractWeakSamples, buildImprovementPrompt, evolveSkill, allNonTripwireAssertionsPass, splitHoldout, restrictReportToSamples } from '../../src/authoring/evolver.js';
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

describe('splitHoldout', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}`);

  it('returns null when ratio is 0 (off)', () => {
    assert.equal(splitHoldout(ids(20), 0), null);
  });

  it('returns null when either side would fall below the minimum subset', () => {
    // N=4, ratio 0.5 → holdout 2 < 3 → disabled.
    assert.equal(splitHoldout(ids(4), 0.5), null);
    // ratio > 1 → holdout > N → train negative → disabled.
    assert.equal(splitHoldout(ids(10), 1.5), null);
  });

  it('splits at an even stride into disjoint train / holdout covering all ids', () => {
    const split = splitHoldout(ids(10), 0.3);
    assert.ok(split);
    assert.equal(split!.holdoutIds.size, 3);
    assert.equal(split!.trainIds.size, 7);
    // Even stride over 10 with 3 held out → indices 0, 3, 6.
    assert.deepEqual([...split!.holdoutIds].sort(), ['s0', 's3', 's6']);
    // Disjoint and exhaustive.
    for (const id of split!.holdoutIds) assert.ok(!split!.trainIds.has(id));
    assert.equal(split!.holdoutIds.size + split!.trainIds.size, 10);
  });

  it('is deterministic across calls (stable split, no RNG)', () => {
    const a = splitHoldout(ids(17), 0.25);
    const b = splitHoldout(ids(17), 0.25);
    assert.deepEqual([...a!.holdoutIds], [...b!.holdoutIds]);
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

describe('evolveSkill', () => {
  it('is a function', () => {
    assert.equal(typeof evolveSkill, 'function');
  });
});
