import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { traceSnapshotFixture } from '../helpers/knowledge-source.js';
import { sourceSnapshotProjection, sourceVersionPreimage } from '../../src/knowledge/sources.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { sourceCoverageUnresolved } from '../../src/knowledge/source-review-history.js';
import { sourceReviewInput } from '../../src/knowledge/extraction/source-review-input.js';
import { ASSOCIATION_GENERATION_PROFILE, BODY_GENERATION_PROFILE } from '../../src/knowledge/extraction/body-generation-wire.js';
import { checkGeneratedSourceCoverage, checkGeneratedSourceLedger, sourceCoverageModelInput, sourceLedgerModelInput,
  SOURCE_COVERAGE_GENERATION_PROFILE, SOURCE_LEDGER_GENERATION_PROFILE } from '../../src/knowledge/extraction/source-review-wire.js';
import { sourceReviewModelFixture } from './source-review-model-fixtures.js';

const { source, metadataQuote, originalQuote, locator, ledgerOutput, body, bodyQuote,
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
    expect(SOURCE_LEDGER_GENERATION_PROFILE).toMatchObject({ stageKind: 'source_ledger', outputName: 'knowledge_source_ledger_v2', promptVersion: 'knowledge-source-ledger-generation/v3',
      profileId: 'sha256:0b30b7aea7c8896434c08b6264d9ce8eefee8e0a3a1738b51ec94a2aa75f16db',
      wireId: 'sha256:19ef35f73530a37d8ec056989fc5794c936eede9948b7c926438f73d272fc3f6' });
    expect(SOURCE_COVERAGE_GENERATION_PROFILE).toMatchObject({ stageKind: 'source_coverage', outputName: 'knowledge_source_coverage_v3', promptVersion: 'knowledge-source-coverage-generation/v4' });
    expect(BODY_GENERATION_PROFILE.profileId).toBe('sha256:3ea3324c1b8a537eca2c94ea6a6b40e8267ae5427435980c007f082b87887dc2');
    expect(ASSOCIATION_GENERATION_PROFILE.profileId).toBe('sha256:7b4ae125132697ac9c251c3b6d75f6dfaa09c07f253a53e190811ed9ed9fdb80');
    expect(SOURCE_LEDGER_GENERATION_PROFILE.profileId).not.toBe(SOURCE_COVERAGE_GENERATION_PROFILE.profileId);
    for (const profile of [SOURCE_LEDGER_GENERATION_PROFILE, SOURCE_COVERAGE_GENERATION_PROFILE]) {
      expect(Object.isFrozen(profile.wireSchema)).toBe(true);
      expect(JSON.stringify(profile.wireSchema)).not.toMatch(/"(?:start|end|actor|decisionKind|bodyDigest)"/);
    }
    expect(() => checkGeneratedSourceLedger(JSON.stringify({ ...ledgerOutput(), decisionKind: 'proceed_with_limits' }), [source])).toThrow(/wire rejected/);
    expect(JSON.stringify(SOURCE_LEDGER_GENERATION_PROFILE.wireSchema)).not.toContain('"itemIds"');
    expect(() => checkGeneratedSourceLedger(JSON.stringify({ ...ledgerOutput(), schemaVersion: 1 }), [source])).toThrow(/wire rejected/);
    const oldIndex = ledgerOutput(); Object.assign(oldIndex.unitDispositions[0], { itemIds: ['identity'] });
    expect(() => checkGeneratedSourceLedger(JSON.stringify(oldIndex), [source])).toThrow(/wire rejected/);
    const offset = ledgerOutput(); Object.assign(offset.items[1].evidence[0], { start: 0 });
    expect(() => checkGeneratedSourceLedger(JSON.stringify(offset), [source])).toThrow(/wire rejected/);
    expect(JSON.stringify(SOURCE_COVERAGE_GENERATION_PROFILE.wireSchema)).toContain('"targetKey"');
    expect(JSON.stringify(SOURCE_COVERAGE_GENERATION_PROFILE.wireSchema)).not.toMatch(/"(?:target|targetKind|itemId|facetId|bodyRef)"/);
    for (const schemaVersion of [1, 2]) {
      expect(() => checkGeneratedSourceCoverage(JSON.stringify({ ...coverageOutput(), schemaVersion }), [source], ledger(), [body()])).toThrow(/wire rejected/);
    }
    const oldTarget = coverageOutput(); Object.assign(oldTarget.checks[4], { target: { targetKind: 'ledger_facet', itemId: null, facetId: 'amount-value' } });
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(oldTarget), [source], ledger(), [body()])).toThrow(/wire rejected/);
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

    const repeated = { ...source, excerpts: source.excerpts.map(excerpt => ({ ...excerpt, material: source.material })) };
    repeated.sourceVersion = `sha256:${createHash('sha256').update(canonicalJson(sourceVersionPreimage(sourceSnapshotProjection(repeated)))).digest('hex')}`;
    const metadata = JSON.parse(sourceReviewInput([repeated]).units[0].text), response = ledgerOutput();
    response.items[0].evidence = [locator('s0/metadata', repeated.material.reason)];
    expect(() => checkGeneratedSourceLedger(JSON.stringify(response), [repeated])).toThrow('ambiguous_quote');
    const scopedQuote = `"source":${canonicalJson(metadata.source)}`;
    response.items[0].evidence = [locator('s0/metadata', scopedQuote)];
    expect(checkGeneratedSourceLedger(JSON.stringify(response), [repeated]).items[0].evidence[0]).toMatchObject({ unitKind: 'source_metadata', quote: scopedQuote });
  });

  it('derives ordered unit item references from validated item and facet evidence while preserving dispositions', () => {
    const omitted = ledgerOutput(); omitted.unitDispositions.shift();
    expect(() => checkGeneratedSourceLedger(JSON.stringify(omitted), [source])).toThrow(/unit dispositions/);
    const excluded = ledgerOutput(); excluded.unitDispositions[0].disposition = 'pending'; excluded.items[0].disposition = 'exclude';
    const data = checkGeneratedSourceLedger(JSON.stringify(excluded), [source]);
    expect(data.unitDispositions[0].disposition).toBe('pending'); expect(data.items[0].disposition).toBe('exclude');
    expect(data).not.toHaveProperty('decision');
    const indexed = ledgerOutput(), reason = '  Preserve this source opinion exactly.\n';
    indexed.unitDispositions[0].reason = reason; indexed.unitDispositions[0].disposition = 'pending';
    indexed.items[1].evidence.push(structuredClone(indexed.items[1].evidence[0]));
    indexed.items[1].facets[0].evidence.push(locator('s0/metadata', metadataQuote), locator('s0/metadata', metadataQuote));
    indexed.items.unshift({ ...structuredClone(indexed.items[1]), itemId: 'z-first', facets: [] });
    const before = JSON.stringify(indexed), compiled = checkGeneratedSourceLedger(before, [source]);
    expect(compiled.unitDispositions).toEqual([
      { unitKey: 's0/metadata', disposition: 'pending', reason, itemIds: ['identity', 'amount'] },
      { unitKey: 's0/excerpt/0', disposition: 'retain', reason: indexed.unitDispositions[1].reason, itemIds: ['z-first', 'amount'] },
    ]);
    expect(JSON.stringify(indexed)).toBe(before);
    const empty = ledgerOutput(); empty.items = [];
    expect(() => checkGeneratedSourceLedger(JSON.stringify(empty), [source])).toThrow(/Retained source unit requires an item/);

  });

  it('checks all units, items, facets and exact body paragraphs without letting all-covered become an approval', () => {
    const currentLedger = ledger(), response = coverageOutput(), original = JSON.stringify(response);
    const checked = checkGeneratedSourceCoverage(original, [source], currentLedger, [body()]);
    expect(checked.bodyRefs).toEqual([{ knowledgeId: body().knowledgeId, revisionId: body().revisionId, bodyDigest: body().bodyDigest }]);
    const request = JSON.parse(sourceCoverageModelInput([source], currentLedger, [body()]));
    expect(request.targets).toEqual([
      { targetKey: 't0', target: { targetKind: 'source_unit', unitKey: 's0/metadata' } },
      { targetKey: 't1', target: { targetKind: 'source_unit', unitKey: 's0/excerpt/0' } },
      { targetKey: 't2', target: { targetKind: 'ledger_item', itemId: 'identity' } },
      { targetKey: 't3', target: { targetKind: 'ledger_item', itemId: 'amount' } },
      { targetKey: 't4', target: { targetKind: 'ledger_facet', itemId: 'amount', facetId: 'amount-value' } },
      { targetKey: 't5', target: { targetKind: 'body_segment', bodyRef: checked.bodyRefs[0], segmentId: 's1' } },
    ]);
    expect(checked.checks.map(check => check.target)).toEqual(request.targets.map((entry: { target: unknown }) => entry.target));
    expect(checked.checks[4].target).toEqual({ targetKind: 'ledger_facet', itemId: 'amount', facetId: 'amount-value' });
    expect(checked.checks).toHaveLength(6); expect(checked).not.toHaveProperty('decision');
    expect(sourceCoverageUnresolved(checked, currentLedger.data)).toEqual([]);
    expect(JSON.stringify(response)).toBe(original);
    const incomplete = coverageOutput(); incomplete.checks.splice(4, 1);
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(incomplete), [source], currentLedger, [body()])).toThrow(/every exact/);
    const bodySpoof = coverageOutput(); bodySpoof.checks[5].targetKey = 'not-delivered';
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(bodySpoof), [source], currentLedger, [body()])).toThrow(/Unknown source coverage target key/);
    expect(() => checkGeneratedSourceCoverage(original, [source], currentLedger, [])).toThrow(/Unknown source coverage body segment/);
    const otherSource = traceSnapshotFixture('Different source.', { snapshotId: '00000000-0000-4000-8000-000000000013' });
    expect(() => sourceCoverageModelInput([source, otherSource], currentLedger, [body()])).toThrow(/manifest mismatch/);
  });

  it('separates a preserved unknown from a known factual value without weakening quote validation', () => {
    const currentLedger = ledger(), unknown = coverageOutput();
    unknown.checks[4].coverageTarget = 'factual_value'; unknown.checks[4].factualValue = 'unknown';
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(unknown), [source], currentLedger, [body()])).toThrow(/Unknown factual value/);
    unknown.checks[4].status = 'unassessable';
    expect(checkGeneratedSourceCoverage(JSON.stringify(unknown), [source], currentLedger, [body()]).checks[4]).toMatchObject({ status: 'unassessable', factualValue: 'unknown' });
    const separateMetrics = coverageOutput(); separateMetrics.checks.push({ ...unknown.checks[4], checkId: 'unknown-value' });
    expect(checkGeneratedSourceCoverage(JSON.stringify(separateMetrics), [source], currentLedger, [body()]).checks).toHaveLength(7);
    separateMetrics.checks.push({ ...unknown.checks[4], checkId: 'duplicate-factual-value' });
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(separateMetrics), [source], currentLedger, [body()])).toThrow(/duplicate/i);
    const sourceSpoof = coverageOutput(); sourceSpoof.checks[0].sourceEvidence[0].quote = 'Not in the source.';
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(sourceSpoof), [source], currentLedger, [body()])).toThrow('quote_mismatch');
    const bodySpoof = coverageOutput(); bodySpoof.checks[5].bodyEvidence[0].quote = 'Not in the body.';
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(bodySpoof), [source], currentLedger, [body()])).toThrow('quote_mismatch');
  });

  it('compiles a complete two-source inspection declaration into the exact host manifest witness', () => {
    const other = traceSnapshotFixture('Another explicitly selected source.', { snapshotId: '00000000-0000-4000-8000-000000000012' });
    const sources = [other, source], completeInput = sourceReviewInput(sources), proposedLedger = ledgerOutput();
    proposedLedger.unitDispositions.push(...completeInput.manifest.units.slice(2).map(unit => ({ unitKey: unit.unitKey,
      disposition: 'pending', reason: 'This additional selected source remains unresolved.' })));
    const completeLedger = { ref: ledger().ref, data: checkGeneratedSourceLedger(JSON.stringify(proposedLedger), sources) };
    const priorTargets = JSON.parse(sourceCoverageModelInput([source], ledger(), [body()])).targets as { targetKey: string; target: unknown }[];
    const targets = JSON.parse(sourceCoverageModelInput(sources, completeLedger, [body()])).targets as typeof priorTargets;
    const priorChecks = coverageOutput().checks, response = coverageOutput();
    response.checks = targets.map(({ targetKey, target }): typeof priorChecks[number] => {
      const prior = priorTargets.find(entry => canonicalJson(entry.target) === canonicalJson(target));
      const check = priorChecks.find(check => check.targetKey === prior?.targetKey);
      return check ? { ...check, targetKey } : { checkId: targetKey, targetKey, coverageTarget: 'knowledge_meaning', status: 'unassessable',
        factualValue: 'not_applicable', reason: 'Additional source remains unresolved.', sourceEvidence: [], bodyEvidence: [], boundedInput: null };
    });
    const bounded = response.checks.at(-1)!;
    bounded.coverageTarget = 'preserved_bounded_input_limitation'; bounded.sourceEvidence = [];
    bounded.bodyEvidence = [bodyQuote('本次选定输入没有给出金额值')];
    const unitKeys = completeInput.manifest.units.map(unit => unit.unitKey), scope = 'Only this complete selected input is inspected.';
    bounded.boundedInput = { inspectionKind: 'complete_manifest_units', inspectedUnitKeys: [...unitKeys].reverse(), scope };
    const raw = JSON.stringify(response), checked = checkGeneratedSourceCoverage(raw, sources, completeLedger, [body()]);
    expect(checked.checks.at(-1)?.boundedInput).toEqual({ sourceInputDigest: completeInput.manifest.sourceInputDigest, unitKeys,
      inspectedFields: [...new Set(completeInput.manifest.units.flatMap(unit => unit.fieldPaths))].sort(), scope });
    expect(checked.checks.at(-1)?.factualValue).toBe('not_applicable');
    expect(JSON.stringify(response)).toBe(raw);

    for (const inspectedUnitKeys of [unitKeys.slice(0, -1), [...unitKeys.slice(0, -1), 'unknown-unit'], [...unitKeys, unitKeys[0]],
      [...unitKeys.slice(0, -1), unitKeys[0]]]) {
      bounded.boundedInput = { inspectionKind: 'complete_manifest_units', inspectedUnitKeys, scope };
      expect(() => checkGeneratedSourceCoverage(JSON.stringify(response), sources, completeLedger, [body()])).toThrow(/every exact manifest unit once/);
    }
    bounded.boundedInput = null;
    expect(() => checkGeneratedSourceCoverage(JSON.stringify(response), sources, completeLedger, [body()])).toThrow(/exact inspected input/);
    for (const declaration of [{ inspectedUnitKeys: unitKeys, scope }, { inspectionKind: 'complete_manifest_units', inspectedUnitKeys: unitKeys,
      inspectedFields: ['s0/metadata.text: complete JSON'], scope }]) {
      Object.assign(bounded, { boundedInput: declaration });
      expect(() => checkGeneratedSourceCoverage(JSON.stringify(response), sources, completeLedger, [body()])).toThrow(/wire rejected/);
    }
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
    expect(JSON.parse(sourceCoverageModelInput([source], currentLedger, [])).targets).toHaveLength(5);
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
