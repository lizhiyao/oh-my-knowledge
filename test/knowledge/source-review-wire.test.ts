import { describe, expect, it } from 'vitest';
import { traceSnapshotFixture } from '../helpers/knowledge-source.js';
import { sourceCoverageUnresolved } from '../../src/knowledge/source-review-history.js';
import { sourceReviewInput } from '../../src/knowledge/extraction/source-review-input.js';
import { checkGeneratedSourceCoverage, checkGeneratedSourceLedger, sourceCoverageModelInput, sourceLedgerModelInput,
  SOURCE_COVERAGE_GENERATION_PROFILE, SOURCE_LEDGER_GENERATION_PROFILE } from '../../src/knowledge/extraction/source-review-wire.js';
import { sourceReviewModelFixture } from './source-review-model-fixtures.js';

const { source, input, metadataQuote, originalQuote, locator, ledgerOutput, body, bodyQuote,
  coverageOutput, emptyCoverageOutput, ledger } = sourceReviewModelFixture();

describe('source review wire and deterministic unit compilation', () => {
  it('materializes complete portable metadata and excerpt units without sending retained raw envelopes or capture time', () => {
    const changedCapture = { ...source, capturedAt: '2026-10-31T00:00:00Z' }, original = sourceReviewInput([source]), changed = sourceReviewInput([changedCapture]);
    expect(original.manifest.sources[0].snapshotDigest).not.toBe(changed.manifest.sources[0].snapshotDigest);
    expect(original.manifest.sourceInputDigest).toBe(changed.manifest.sourceInputDigest);
    expect(original.units).toEqual(changed.units);
    expect(original.manifest.units.map(unit => unit.unitKind)).toEqual(['source_metadata', 'excerpt_text']);
    expect(JSON.parse(original.units[0].text)).toMatchObject({ source: { identity: source.identity, material: source.material, provenance: source.provenance },
      excerpts: [{ coordinate: source.excerpts[0].coordinate, material: source.excerpts[0].material }] });
    expect(original.units[0].fieldPaths).toContain('/excerpts/0/coordinate/recordIndex');
    const sent = sourceLedgerModelInput([source]);
    expect(sent).not.toContain('rawUnits'); expect(sent).not.toContain('rawByteDigest'); expect(sent).not.toContain('capturedAt');
    expect(sent).toContain(source.excerpts[0].text);
    const other = traceSnapshotFixture('Other explicitly selected source.', { snapshotId: '00000000-0000-4000-8000-000000000012' });
    expect(sourceReviewInput([other, source])).toEqual(sourceReviewInput([source, other]));
    expect(() => sourceReviewInput([source, source])).toThrow(/Duplicate source/);
  });

  it('publishes strict, immutable new profiles whose model outputs cannot supply host offsets or acceptance', () => {
    expect(SOURCE_LEDGER_GENERATION_PROFILE).toMatchObject({ stageKind: 'source_ledger', outputName: 'knowledge_source_ledger_v1', promptVersion: 'knowledge-source-ledger-generation/v1' });
    expect(SOURCE_COVERAGE_GENERATION_PROFILE).toMatchObject({ stageKind: 'source_coverage', outputName: 'knowledge_source_coverage_v1' });
    expect(SOURCE_LEDGER_GENERATION_PROFILE.profileId).not.toBe(SOURCE_COVERAGE_GENERATION_PROFILE.profileId);
    for (const profile of [SOURCE_LEDGER_GENERATION_PROFILE, SOURCE_COVERAGE_GENERATION_PROFILE]) {
      expect(Object.isFrozen(profile.wireSchema)).toBe(true);
      expect(JSON.stringify(profile.wireSchema)).not.toMatch(/"(?:start|end|actor|decisionKind|bodyDigest)"/);
    }
    expect(() => checkGeneratedSourceLedger(JSON.stringify({ ...ledgerOutput(), decisionKind: 'proceed_with_limits' }), [source])).toThrow(/wire rejected/);
    const offset = ledgerOutput(); Object.assign(offset.items[1].evidence[0], { start: 0 });
    expect(() => checkGeneratedSourceLedger(JSON.stringify(offset), [source])).toThrow(/wire rejected/);
  });

  it('preserves metadata custody and host UTF-16 positions while rejecting ambiguous or substituted units', () => {
    const output = ledgerOutput(); output.items[1].evidence = [locator('s0/excerpt/0', 'Alpha', '🙂 ', ' happens')];
    const saved = checkGeneratedSourceLedger(JSON.stringify(output), [source]);
    expect(saved.items[1].evidence[0]).toEqual({ unitKey: 's0/excerpt/0', unitKind: 'excerpt_text', quote: 'Alpha', start: 3, end: 8 });
    expect(saved.items[0].evidence[0]).toMatchObject({ unitKind: 'source_metadata', quote: metadataQuote });
    output.items[1].evidence[0] = locator('s0/excerpt/0', 'Alpha');
    expect(() => checkGeneratedSourceLedger(JSON.stringify(output), [source])).toThrow('ambiguous_quote');
    output.items[1].evidence[0] = locator('s0/excerpt/0', metadataQuote);
    expect(() => checkGeneratedSourceLedger(JSON.stringify(output), [source])).toThrow('quote_mismatch');
    output.items[1].evidence[0] = locator('invented-unit', originalQuote);
    expect(() => checkGeneratedSourceLedger(JSON.stringify(output), [source])).toThrow(/Unknown source review unit/);
  });

  it('requires every delivered source unit to have a disposition and keeps explicit exclusions or pending opinions', () => {
    const omitted = ledgerOutput(); omitted.unitDispositions.shift();
    expect(() => checkGeneratedSourceLedger(JSON.stringify(omitted), [source])).toThrow(/unit dispositions/);
    const excluded = ledgerOutput(); excluded.unitDispositions[0].disposition = 'pending'; excluded.items[0].disposition = 'exclude';
    const data = checkGeneratedSourceLedger(JSON.stringify(excluded), [source]);
    expect(data.unitDispositions[0].disposition).toBe('pending'); expect(data.items[0].disposition).toBe('exclude');
    expect(data).not.toHaveProperty('decision');
  });

  it('checks all units, items, facets and exact body paragraphs without letting all-covered become an approval', () => {
    const currentLedger = ledger(), response = coverageOutput(), original = JSON.stringify(response);
    const checked = checkGeneratedSourceCoverage(original, [source], currentLedger, [body()]);
    expect(checked.bodyRefs).toEqual([{ knowledgeId: body().knowledgeId, revisionId: body().revisionId, bodyDigest: body().bodyDigest }]);
    expect(checked.checks).toHaveLength(6); expect(checked).not.toHaveProperty('decision');
    expect(sourceCoverageUnresolved(checked, currentLedger.data)).toEqual([]);
    expect(JSON.stringify(response)).toBe(original);
    const incomplete = coverageOutput(); incomplete.checks.splice(4, 1);
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(incomplete), [source], currentLedger, [body()])).toThrow(/every exact/);
    const bodySpoof = coverageOutput(); bodySpoof.checks[5].target.bodyKey = 'not-delivered';
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(bodySpoof), [source], currentLedger, [body()])).toThrow(/Unknown source coverage target body/);
    const otherSource = traceSnapshotFixture('Different source.', { snapshotId: '00000000-0000-4000-8000-000000000013' });
    expect(() => sourceCoverageModelInput([source, otherSource], currentLedger, [body()])).toThrow(/manifest mismatch/);
  });

  it('separates a preserved unknown from a known factual value and binds a bounded-input witness to actual fields', () => {
    const currentLedger = ledger(), unknown = coverageOutput();
    unknown.checks[4].coverageTarget = 'factual_value'; unknown.checks[4].factualValue = 'unknown';
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(unknown), [source], currentLedger, [body()])).toThrow(/Unknown factual value/);
    unknown.checks[4].status = 'unassessable';
    expect(checkGeneratedSourceCoverage(JSON.stringify(unknown), [source], currentLedger, [body()]).checks[4]).toMatchObject({ status: 'unassessable', factualValue: 'unknown' });
    const bounded = coverageOutput(); bounded.checks[4].coverageTarget = 'preserved_bounded_input_limitation'; bounded.checks[4].sourceEvidence = [];
    bounded.checks[4].bodyEvidence = [bodyQuote('本次选定输入没有给出金额值')];
    bounded.checks[4].boundedInput = { unitKeys: input.manifest.units.map(unit => unit.unitKey), inspectedFields: ['/excerpts/0/text'], scope: 'Only this complete selected input is inspected.' };
    const checked = checkGeneratedSourceCoverage(JSON.stringify(bounded), [source], currentLedger, [body()]);
    expect(checked.checks[4].boundedInput?.sourceInputDigest).toBe(input.manifest.sourceInputDigest);
    expect(checked.checks[4].factualValue).toBe('not_applicable');
    bounded.checks[4].boundedInput.inspectedFields = ['/invented/privateField'];
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(bounded), [source], currentLedger, [body()])).toThrow(/field/);
  });

  it('retains independent findings about omissions in the ledger without rewriting that original ledger', () => {
    const currentLedger = ledger(), before = JSON.stringify(currentLedger), response = coverageOutput();
    response.findings.push({ findingId: 'extra-scope', findingKind: 'ledger_omission', reason: 'A omitted the selected-record scope limitation.',
      sourceEvidence: [locator('s0/excerpt/0', 'Only selected records are available.')], bodyEvidence: [] });
    const checked = checkGeneratedSourceCoverage(JSON.stringify(response), [source], currentLedger, [body()]);
    expect(checked.findings[0].sourceEvidence[0].quote).toBe('Only selected records are available.');
    expect(sourceCoverageUnresolved(checked, currentLedger.data)).toContain('finding:extra-scope');
    expect(JSON.stringify(currentLedger)).toBe(before);
  });

  it('checks an empty generated body honestly instead of making a placeholder or claiming coverage', () => {
    const currentLedger = ledger(), response = emptyCoverageOutput();
    const checked = checkGeneratedSourceCoverage(JSON.stringify(response), [source], currentLedger, []);
    expect(checked.bodyRefs).toEqual([]); expect(checked.checks).toHaveLength(5);
    expect(sourceCoverageUnresolved(checked, currentLedger.data).length).toBeGreaterThan(0);
    response.checks[0].status = 'covered';
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(response), [source], currentLedger, [])).toThrow(/cannot be covered/);
  });

  it('rejects capacity overflow before truncation or decoding', () => {
    const tooLarge = traceSnapshotFixture('x'.repeat(1024 * 1024));
    expect(() => sourceLedgerModelInput([tooLarge])).toThrow(/capacity_exceeded/);
    expect(() => checkGeneratedSourceLedger(' '.repeat(16 * 1024 * 1024 + 1), [source])).toThrow(/capacity/);
  });
});
