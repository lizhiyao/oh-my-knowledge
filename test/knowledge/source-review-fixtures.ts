import { sourceReviewRevisionDigest } from '../../src/knowledge/adapters/source-review-store.js';
import type { SourceCoverageData, SourceCoverageRevision, SourceCoverageWrite, SourceLedgerData, SourceLedgerRevision, SourceLedgerWrite } from '../../src/knowledge/source-review.js';
import { bodyAt, bodyWrite } from './body-fixtures.js';

export const reviewActor = { actorKind: 'agent' as const, actorId: 'source-review-fixture', executionRef: 'test:source-review' };
export const reviewId = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const reviewDigest = (char = 'a') => `sha256:${char.repeat(64)}`;
export function sourceReviewFixture() {
  const body = bodyWrite().revision, bodyRef = { knowledgeId: body.knowledgeId, revisionId: body.revisionId, bodyDigest: body.bodyDigest };
  const ledgerData: SourceLedgerData = { manifest: { inputVersion: 'knowledge-source-generation-input/v2', sourceSetId: reviewDigest(), sourceInputDigest: reviewDigest('b'),
    sources: [{ sourceKey: 's1', sourceRef: body.content.segments[0].evidence[0].source, snapshotDigest: reviewDigest('c') }],
    units: [{ unitKey: 's1/metadata', sourceKey: 's1', unitKind: 'source_metadata', evidenceRef: null, utf16Length: 10, textDigest: reviewDigest('d'), fieldPaths: ['/source/sourceKind'] },
      { unitKey: 's1/excerpt/0', sourceKey: 's1', unitKind: 'excerpt_text', evidenceRef: 'record-1', utf16Length: 5, textDigest: reviewDigest('e'), fieldPaths: ['/excerpts/0/text'] }] },
    unitDispositions: [{ unitKey: 's1/metadata', disposition: 'pending', reason: 'Provenance is preserved, not a verified fact.', itemIds: [] },
      { unitKey: 's1/excerpt/0', disposition: 'retain', reason: 'The explicit source assertion matters.', itemIds: ['i1'] }],
    items: [{ itemId: 'i1', statement: 'Alpha is reported, without a known version.', disposition: 'retain', reason: 'Reusable within the bounded source.', equivalentItemIds: [],
      evidence: [{ unitKey: 's1/excerpt/0', unitKind: 'excerpt_text', start: 0, end: 5, quote: 'Alpha' }],
      facets: [{ facetId: 'f1', statement: 'The version value is unknown.', epistemicStatus: 'not_stated', evidence: [] }] }], limitations: ['Source assertions are not verified truth.'] };
  const modelOriginal = { runId: reviewId(1), invocationId: reviewId(2), requestDigest: reviewDigest('f'), archiveRef: 'native:fixture', archiveDigest: reviewDigest(), outputDigest: reviewDigest('b') };
  const ledgerBase = { revisionId: reviewId(3), parentRevisionId: null, modelOriginal, revisedAt: bodyAt, revisedBy: reviewActor, data: ledgerData };
  const ledger: SourceLedgerRevision = { ...ledgerBase, digest: sourceReviewRevisionDigest(ledgerBase) };
  const ledgerRef = { ledgerId: reviewId(4), revisionId: ledger.revisionId, digest: ledger.digest };
  const anchor = ledgerData.items[0].evidence[0], paragraph = body.content.segments[0];
  const bodyEvidence = [{ bodyRef, segmentId: paragraph.segmentId, start: 0, end: paragraph.text.length, quote: paragraph.text }];
  const coverageData: SourceCoverageData = { manifest: structuredClone(ledgerData.manifest), ledgerRef, bodyRefs: [bodyRef],
    checks: [
      { checkId: 'c1', target: { targetKind: 'source_unit', unitKey: 's1/metadata' }, coverageTarget: 'knowledge_meaning', status: 'unassessable', factualValue: 'not_applicable', reason: 'Metadata remains bounded provenance.', sourceEvidence: [], bodyEvidence: [], boundedInput: null },
      { checkId: 'c2', target: { targetKind: 'source_unit', unitKey: 's1/excerpt/0' }, coverageTarget: 'knowledge_meaning', status: 'covered', factualValue: 'not_applicable', reason: 'The paragraph preserves the source assertion.', sourceEvidence: [anchor], bodyEvidence, boundedInput: null },
      { checkId: 'c3', target: { targetKind: 'ledger_item', itemId: 'i1' }, coverageTarget: 'knowledge_meaning', status: 'covered', factualValue: 'not_applicable', reason: 'The item is preserved.', sourceEvidence: [anchor], bodyEvidence, boundedInput: null },
      { checkId: 'c4', target: { targetKind: 'ledger_facet', itemId: 'i1', facetId: 'f1' }, coverageTarget: 'factual_value', status: 'unassessable', factualValue: 'unknown', reason: 'The version value was not supplied.', sourceEvidence: [], bodyEvidence, boundedInput: null },
      { checkId: 'c5', target: { targetKind: 'body_segment', bodyRef, segmentId: paragraph.segmentId }, coverageTarget: 'knowledge_meaning', status: 'covered', factualValue: 'not_applicable', reason: 'The paragraph does not establish truth beyond the source.', sourceEvidence: [anchor], bodyEvidence, boundedInput: null },
    ], findings: [], limitations: ['Unknown version value remains unknown.'] };
  const coverageBase = { revisionId: reviewId(5), parentRevisionId: null, modelOriginal, revisedAt: bodyAt, revisedBy: reviewActor, data: coverageData };
  const coverage: SourceCoverageRevision = { ...coverageBase, digest: sourceReviewRevisionDigest(coverageBase) };
  const coverageRef = { coverageId: reviewId(6), revisionId: coverage.revisionId, digest: coverage.digest };
  const ledgerCommand: SourceLedgerWrite = { commandKind: 'append_analysis', requestId: reviewId(7), ledgerId: ledgerRef.ledgerId, expectedGeneration: 0, expectedHeadEventId: null, revision: ledger };
  const coverageCommand: SourceCoverageWrite = { commandKind: 'append_analysis', requestId: reviewId(8), coverageId: coverageRef.coverageId, expectedGeneration: 0, expectedHeadEventId: null, revision: coverage };
  const decision = (request = 9): Extract<SourceCoverageWrite, { commandKind: 'record_decision' }> => ({ commandKind: 'record_decision', coverageId: coverageRef.coverageId, requestId: reviewId(request), expectedGeneration: 1, expectedHeadEventId: coverageCommand.requestId,
    decision: { coverageRef: structuredClone(coverageRef), sourceSetId: ledgerData.manifest.sourceSetId, ledgerRef: structuredClone(ledgerRef), bodyRefs: [structuredClone(bodyRef)], decisionKind: 'proceed_with_limits', reason: 'Actual Agent inspected the exact input and body.', limitations: ['Agent review is not human Gold.'],
      dispositions: ['unit:s1/metadata', 'check:c1', 'check:c4'].map(unresolvedId => ({ unresolvedId, disposition: 'accepted_limit', reason: 'Preserve the bounded uncertainty, without asserting its value.' })), supersedesEventIds: [] } });
  return { body, bodyRef, ledgerData, ledger, ledgerRef, coverageData, coverage, coverageRef, ledgerCommand, coverageCommand, decision };
}
