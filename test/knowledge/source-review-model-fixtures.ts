import type { z } from 'zod';
import { bodyWrite } from './body-fixtures.js';
import { traceSnapshotFixture } from '../helpers/knowledge-source.js';
import { knowledgeBodyDigest } from '../../src/knowledge/adapters/body-digest.js';
import { sourceReviewInput } from '../../src/knowledge/extraction/source-review-input.js';
import { checkGeneratedSourceLedger, type SourceCoverageResponseSchema } from '../../src/knowledge/extraction/source-review-wire.js';

/** Each suite gets independent source identities and fresh model output/body factories. */
export function sourceReviewModelFixture() {
  const source = traceSnapshotFixture('🙂 Alpha happens twice. Alpha amount unknown. Only selected records are available.',
    { snapshotId: '00000000-0000-4000-8000-000000000011' });
  const input = sourceReviewInput([source]);
  const originalQuote = 'Alpha amount unknown.', metadataQuote = '"sourceId":"authored:wire"';
  const locator = (unitKey: string, quote: string, contextBefore: string | null = null, contextAfter: string | null = null) => ({ unitKey, quote, contextBefore, contextAfter });
  const quotedSource = locator('s0/excerpt/0', originalQuote), quotedMetadata = locator('s0/metadata', metadataQuote);
  const ledgerRef = { ledgerId: '00000000-0000-4000-8000-000000000021', revisionId: '00000000-0000-4000-8000-000000000022', digest: `sha256:${'a'.repeat(64)}` };
  function ledgerOutput() {
    return structuredClone({ responseKind: 'knowledge-source-ledger', schemaVersion: 2,
      unitDispositions: [{ unitKey: 's0/metadata', disposition: 'retain', reason: 'Preserve the selected source identity.' },
        { unitKey: 's0/excerpt/0', disposition: 'retain', reason: 'Preserve the stated unknown.' }],
      items: [{ itemId: 'identity', statement: 'The selected source ID is authored:wire.', disposition: 'retain', reason: 'Scope of this account.', equivalentItemIds: [], evidence: [quotedMetadata], facets: [] },
        { itemId: 'amount', statement: 'Alpha amount is unknown.', disposition: 'retain', reason: 'Do not invent a factual amount.', equivalentItemIds: [], evidence: [quotedSource],
          facets: [{ facetId: 'amount-value', statement: 'The source explicitly leaves the amount unknown.', epistemicStatus: 'explicit_unknown', evidence: [quotedSource] }] }],
      limitations: ['Model inventory only; no factual acceptance.'] });
  }
  function body() {
    const revision = bodyWrite().revision;
    revision.title = 'Known source scope';
    revision.content.segments = [{ segmentId: 's1', text: '在选定来源 authored:wire 中，Alpha amount unknown.；本次选定输入没有给出金额值。',
      evidence: [{ source: { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion }, basis: 'source_assertion',
        selection: { evidenceRef: source.excerpts[0].evidenceRef, quote: originalQuote, start: source.excerpts[0].text.indexOf(originalQuote), end: source.excerpts[0].text.indexOf(originalQuote) + originalQuote.length } }] }];
    revision.bodyDigest = knowledgeBodyDigest(revision);
    return revision;
  }
  const target = (targetKind: 'source_unit' | 'ledger_item' | 'ledger_facet' | 'body_segment', values: Partial<Record<'unitKey' | 'itemId' | 'facetId' | 'bodyKey' | 'segmentId', string>>) =>
    ({ targetKind, unitKey: null, itemId: null, facetId: null, bodyKey: null, segmentId: null, ...values });
  const bodyQuote = (quote: string) => ({ bodyKey: 'b0', segmentId: 's1', quote, contextBefore: null, contextAfter: null });
  function coverageOutput(): z.infer<typeof SourceCoverageResponseSchema> {
    const base = { coverageTarget: 'knowledge_meaning' as const, status: 'covered' as const, factualValue: 'not_applicable' as const,
      reason: 'The paragraph retains this source meaning.', boundedInput: null };
    return structuredClone({ responseKind: 'knowledge-source-coverage', schemaVersion: 1, checks: [
      { ...base, checkId: 'source-metadata', target: target('source_unit', { unitKey: 's0/metadata' }), sourceEvidence: [quotedMetadata], bodyEvidence: [bodyQuote('authored:wire')] },
      { ...base, checkId: 'source-text', target: target('source_unit', { unitKey: 's0/excerpt/0' }), sourceEvidence: [quotedSource], bodyEvidence: [bodyQuote(originalQuote)] },
      { ...base, checkId: 'identity', target: target('ledger_item', { itemId: 'identity' }), sourceEvidence: [quotedMetadata], bodyEvidence: [bodyQuote('authored:wire')] },
      { ...base, checkId: 'amount', target: target('ledger_item', { itemId: 'amount' }), sourceEvidence: [quotedSource], bodyEvidence: [bodyQuote(originalQuote)] },
      { ...base, checkId: 'unknown', target: target('ledger_facet', { itemId: 'amount', facetId: 'amount-value' }), coverageTarget: 'preserved_source_declared_unknown', sourceEvidence: [quotedSource], bodyEvidence: [bodyQuote(originalQuote)] },
      { ...base, checkId: 'paragraph', target: target('body_segment', { bodyKey: 'b0', segmentId: 's1' }), sourceEvidence: [quotedMetadata, quotedSource], bodyEvidence: [bodyQuote(body().content.segments[0].text)] },
    ], findings: [], limitations: ['Structural coverage is not an actual review decision.'] });
  }
  const ledger = () => ({ ref: structuredClone(ledgerRef), data: checkGeneratedSourceLedger(JSON.stringify(ledgerOutput()), [source]) });
  function emptyCoverageOutput() {
    const response = coverageOutput();
    response.checks = response.checks.filter(check => check.target.targetKind !== 'body_segment');
    response.checks.forEach(check => { check.status = 'omitted'; check.bodyEvidence = []; });
    return response;
  }
  return { source, input, originalQuote, metadataQuote, locator, ledgerRef, ledgerOutput, body, bodyQuote,
    coverageOutput, emptyCoverageOutput, ledger };
}
