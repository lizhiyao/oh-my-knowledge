import { describe, expect, it } from 'vitest';
import { traceSnapshotFixture } from '../helpers/knowledge-source.js';
import { BODY_GENERATION_PROFILE, generationTextDigest } from '../../src/knowledge/extraction/body-generation-wire.js';
import { BODY_WINDOW_PROFILE, type BodyWindowGenerationResponseSchema, LONG_BODY_WINDOW_INPUT_VERSION, LongBodyCapacityError, LongBodyPlanSchema, assertLongBodyWindowInputs, bodyWindowInput,
  checkLongBodyWindowOutput, collectLongBodyWindows, createLongBodyPlan } from '../../src/knowledge/extraction/long-body.js';
import { bodyGenerationSources } from '../../src/knowledge/extraction/source-input.js';
import { sourceSetPreimage } from '../../src/knowledge/sources.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import type { z } from 'zod';

const alpha = traceSnapshotFixture('Earlier state.\n' + '🐙 alpha\r\n'.repeat(7200), {
  snapshotId: '00000000-0000-4000-8000-000000000001', evidenceRef: 'first-record',
});
const beta = traceSnapshotFixture('Later state.\n' + 'beta 中文\r\n'.repeat(7200), {
  snapshotId: '00000000-0000-4000-8000-000000000002', evidenceRef: 'second-record',
});
const sources = [beta, alpha];
const sourceSetId = generationTextDigest(canonicalJson(sourceSetPreimage(sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion })))));
const plan = createLongBodyPlan(sources);
const full = bodyGenerationSources(sources);
type Projection = ReturnType<typeof bodyGenerationSources>;
type Response = z.infer<typeof BodyWindowGenerationResponseSchema>;
type CoverageRegion = { startPassageId: string; endPassageId: string };
function decode(input: string) {
  return JSON.parse(input) as Projection & { planDigest: string;
    inputVersion: string; coverageRegions?: CoverageRegion[]; bodyWindow: { index: number; count: number; visiblePassageCount: number } };
}
const passages = (projection: Projection) => projection.sources.flatMap(source => source.excerpts.flatMap(excerpt => excerpt.passages));
const evidence = (startPassageId: string, endPassageId = startPassageId) =>
  ({ startPassageId, endPassageId, basis: 'source_assertion' as const, interpretation: null });
const proposal = (proposalId: string, start: string, end = start): Response['proposals'][number] => ({
  proposalId, title: 'A sourced state', organization: null, reuseRationale: 'Preserve its source time and attribution.', requiredContexts: [],
  segments: [{ segmentId: 'first', text: 'The source reports a state.', evidence: [evidence(start, end)] }],
});
const output = (...proposals: Response['proposals']) =>
  JSON.stringify({ responseKind: 'knowledge-body-window-generation', schemaVersion: 1, proposals });
const outputs = plan.windows.map(window => output(proposal('window-proposal', window.startPassageId)));

describe('bounded source windows and deterministic publication', () => {
  it('assigns every original passage to one ordered bounded window across sources and preserves native identity', () => {
    expect(plan.windows.length).toBeGreaterThan(1);
    expect(LongBodyPlanSchema.parse(plan)).toEqual(createLongBodyPlan([alpha, beta]));
    const windows = plan.windows.map((window, ordinal) => {
      const input = decode(bodyWindowInput(sources, sourceSetId, plan, ordinal));
      expect(input.planDigest).toBe(plan.planDigest);
      expect(input.passageIndexDigest).toBe(full.passageIndexDigest);
      expect(input).not.toHaveProperty('writingDraft');
      expect(input.inputVersion).toBe(LONG_BODY_WINDOW_INPUT_VERSION);
      expect(input.bodyWindow).toEqual({ index: ordinal + 1, count: plan.windows.length, visiblePassageCount: window.visiblePassageCount });
      const visible = passages(input);
      expect(visible[0].passageId).toBe(window.startPassageId);
      expect(visible.at(-1)!.passageId).toBe(window.endPassageId);
      expect(Buffer.byteLength(canonicalJson(visible))).toBeLessThanOrEqual(128 * 1024);
      return visible;
    });
    expect(windows.flat()).toEqual(passages(full));
    expect(windows.map(window => window.length)).toEqual(plan.windows.map(window => window.visiblePassageCount));
    expect(() => bodyWindowInput(sources, sourceSetId, { ...plan, planDigest: generationTextDigest('other') }, 0)).toThrow('plan mismatch');
    expect(() => bodyWindowInput(sources, sourceSetId, plan, -1)).toThrow('Unknown long body window');
    expect(BODY_WINDOW_PROFILE).toMatchObject({ promptVersion: 'knowledge-body-window/v4', outputName: 'knowledge_body_window_v1' });
    expect(BODY_WINDOW_PROFILE.wireSchema.properties).not.toHaveProperty('passageIndexDigest');
    expect(BODY_GENERATION_PROFILE.wireSchema.properties).toHaveProperty('passageIndexDigest');
    expect(BODY_WINDOW_PROFILE.wireId).not.toBe(BODY_GENERATION_PROFILE.wireId);
    expect(BODY_WINDOW_PROFILE.profileId).not.toBe(BODY_GENERATION_PROFILE.profileId);
    expect(() => assertLongBodyWindowInputs(sources, sourceSetId, plan)).not.toThrow();
    expect(() => createLongBodyPlan([traceSnapshotFixture('\\'.repeat(550 * 1024))])).toThrow(LongBodyCapacityError);
  });

  it('balances navigation regions around nearby record boundaries without moving a passage', () => {
    const early = traceSnapshotFixture('a'.repeat(29 * 1024), { snapshotId: alpha.snapshotId });
    const late = traceSnapshotFixture('b'.repeat(140 * 1024), { snapshotId: beta.snapshotId });
    const ordered = [early, late], shapedPlan = createLongBodyPlan(ordered);
    const shapedSetId = generationTextDigest(canonicalJson(sourceSetPreimage(ordered.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion })))));
    const input = decode(bodyWindowInput(ordered, shapedSetId, shapedPlan, 0));
    const regions = input.coverageRegions!;
    const visible = passages(input);
    const sourceBoundary = input.sources[1].excerpts[0].passages[0].passageId;
    expect(regions).toHaveLength(4);
    expect(regions.map(region => region.startPassageId)).toContain(sourceBoundary);
    const assigned = regions.flatMap(region => visible.slice(
      visible.findIndex(passage => passage.passageId === region.startPassageId),
      visible.findIndex(passage => passage.passageId === region.endPassageId) + 1,
    ));
    expect(assigned).toEqual(visible);
    expect(decode(bodyWindowInput([late, early], shapedSetId, shapedPlan, 0)).coverageRegions).toEqual(regions);
  });

  it('omits navigation regions when the original window fills the input budget', () => {
    const withPadding = (length: number) => [beta, { ...alpha, limitations: ['x'.repeat(length)] }];
    const input = decode(bodyWindowInput(withPadding(1), sourceSetId, plan, 0));
    const { coverageRegions, ...original } = input;
    expect(coverageRegions).toHaveLength(4);
    const length = 192 * 1024 - Buffer.byteLength(canonicalJson(original)) + 1;
    const filled = bodyWindowInput(withPadding(length), sourceSetId, plan, 0);
    expect(Buffer.byteLength(filled)).toBe(192 * 1024);
    expect(decode(filled).coverageRegions).toBeUndefined();
    expect(passages(decode(filled))).toEqual(passages(input));
  });

  it('preflights complete serialized windows including portable metadata', () => {
    const withOversizedMetadata = [beta, { ...alpha, limitations: ['x'.repeat(192 * 1024)] }];
    expect(createLongBodyPlan(withOversizedMetadata)).toEqual(plan);
    expect(() => assertLongBodyWindowInputs(withOversizedMetadata, sourceSetId, plan)).toThrow('Long body model input capacity exceeded');
  });

  it('rejects out-of-window references, rejected native proposals and oversized output before accepting window evidence', () => {
    const first = plan.windows[0], later = plan.windows[1];
    const candidate = proposal('first', first.startPassageId);
    expect(checkLongBodyWindowOutput(output(candidate), sources, plan, 0).accepted).toHaveLength(1);
    expect(checkLongBodyWindowOutput(output(), sources, plan, 0).accepted).toEqual([]);
    const extraDigest = { responseKind: 'knowledge-body-window-generation', schemaVersion: 1, passageIndexDigest: plan.passageIndexDigest, proposals: [candidate] };
    expect(() => checkLongBodyWindowOutput(JSON.stringify(extraDigest), sources, plan, 0)).toThrow('passageIndexDigest');
    expect(() => checkLongBodyWindowOutput(JSON.stringify({ ...extraDigest, responseKind: 'knowledge-body-generation', schemaVersion: 3 }), sources, plan, 0))
      .toThrow('knowledge-body-window-generation');
    expect(() => checkLongBodyWindowOutput(output(proposal('cross', first.endPassageId, later.startPassageId)), sources, plan, 0))
      .toThrow('outside the visible window');
    candidate.requiredContexts.push({ literal: 'absent literal', evidence: evidence(first.startPassageId) });
    expect(() => checkLongBodyWindowOutput(output(candidate), sources, plan, 0)).toThrow('rejected proposals');
    const large = proposal('large', first.startPassageId);
    large.segments[0].text = 'x'.repeat(25 * 1024);
    expect(() => checkLongBodyWindowOutput(output(large), sources, plan, 0)).toThrow('output capacity');
    const proposals = Array.from({ length: 5 }, (_, i) => proposal(`proposal-${i}`, first.startPassageId));
    expect(() => checkLongBodyWindowOutput(output(...proposals), sources, plan, 0)).toThrow('segment capacity');
    const twoSegments = proposals.slice(0, 4).map(p => ({ ...p,
      segments: [p.segments[0], { ...p.segments[0], segmentId: 'second' }],
    }));
    expect(() => checkLongBodyWindowOutput(output(...twoSegments), sources, plan, 0)).toThrow('segment capacity');
  });

  it('preserves exact window content and citation identities when local proposal IDs recur', () => {
    const result = collectLongBodyWindows(sources, plan, outputs);
    expect(result.rejected).toEqual([]);
    expect(result.accepted.map(item => item.proposalId)).toEqual(plan.windows.map((_, ordinal) => `w${ordinal}-p0`));
    expect(result.accepted.map(item => item.windowOrdinal)).toEqual(plan.windows.map((_, ordinal) => ordinal));
    expect(result.accepted.map(item => item.draft)).toEqual(outputs.flatMap((raw, ordinal) =>
      checkLongBodyWindowOutput(raw, sources, plan, ordinal).accepted.map(item => item.draft)));
    expect(collectLongBodyWindows(sources, plan, outputs.map(() => output())).accepted).toEqual([]);
  });

  it('rejects incomplete, reordered and invalid window output without returning partial bodies', () => {
    expect(() => collectLongBodyWindows(sources, plan, outputs.slice(1))).toThrow('one result per window');
    expect(() => collectLongBodyWindows(sources, plan, [...outputs].reverse())).toThrow('outside the visible window');
    const last = plan.windows.at(-1)!.startPassageId, invalid = proposal('invalid', last);
    invalid.requiredContexts.push({ literal: 'not present', evidence: evidence(last) });
    expect(() => collectLongBodyWindows(sources, plan, [...outputs.slice(0, -1), output(invalid)])).toThrow('rejected proposals');
  });
});
