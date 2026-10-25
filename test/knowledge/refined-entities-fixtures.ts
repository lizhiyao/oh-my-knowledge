import { vi } from 'vitest';
import type { ExtractionOutcome } from '../../src/knowledge/extraction/runs.js';
import type { EntityDiscoveryResponse } from '../../src/knowledge/extraction/entity-discovery.js';
import { buildMentionBindingInput, type MentionBindingResponse } from '../../src/knowledge/extraction/mention-binding.js';
import { mentionBindingExecution } from '../../src/knowledge/extraction/discovered-entities-evidence.js';
import { buildEntityRefinementInput, type EntityRefinementResponse } from '../../src/knowledge/extraction/entity-refinement.js';
import { buildMentionRebindingInput, type MentionRebindingResponse } from '../../src/knowledge/extraction/mention-rebinding.js';
import { readRefinedEntitiesBaseEvidence, entityRefinementExecution, mentionRebindingExecution,
  readEntityRefinementEvidence, readMentionRebindingEvidence, entityRefinementRequestDigest, mentionRebindingRequestDigest,
  type EntityRefinementReceipt, type MentionRebindingReceipt, type RefinedEntitiesArchivePort } from '../../src/knowledge/extraction/refined-entities-evidence.js';
import { discoveredEntitiesFixture, discoveryBytes, discoveryHash, discoveryRef, discoveryUid } from './discovered-entities-fixtures.js';

/** Authored five-original fixtures only; no provider execution, semantic-quality evidence or human review. */
export function refinedEntitiesFixture(executor: 'codex' | 'openai-api' = 'codex',
  options: { collection?: boolean; unresolved?: boolean; wideGap?: boolean; ambiguousGap?: boolean; overlappingGap?: boolean } = {}) {
  const old = discoveredEntitiesFixture(executor, '😀 Alpha 使用 Beta；Gamma 与 Gamma；该组指前两者；它身份未明。');
  const { source, model, sourcePlanArchive } = old;
  const a = old.discoveryResponse as unknown as EntityDiscoveryResponse;
  const b = old.bindingResponse as unknown as MentionBindingResponse;
  const selection = (quote: string, occurrence: number | null = null) => ({ evidenceRef: 'record-1', quote, occurrence });
  if (options.collection) {
    a.entities.push({ entityId: 'g', label: '该组', description: 'Authored bounded group.', qualifiers: [], identityStatus: 'proposed',
      possibleEntityIds: [], uncertainties: [], referentKind: 'collection', componentRef: null,
      collection: { memberEntityIds: ['e0', 'e1'], completeness: 'complete', anchorIds: ['ag'], rationale: 'Authored joint reference.' } });
    a.anchors.push({ anchorId: 'ag', entityId: 'g', selection: selection('该组') });
    b.mentions.push({ mentionId: 'mg', selection: selection('该组'), basis: 'explicit', rationale: 'Authored group mention.',
      bindingStatus: 'bound', entityId: 'g', candidateEntityIds: [], reason: null });
    b.identitySupports.push({ entityId: 'g', supportKind: 'collection', mentionIds: ['mg'] });
  }
  if (options.unresolved) {
    a.entities.push({ entityId: 'u', label: '它', description: 'Authored unresolved referent, not a semantic verdict.', qualifiers: [],
      identityStatus: 'unresolved', possibleEntityIds: ['e0', 'e1'], uncertainties: ['Authored unresolved identity.'],
      referentKind: 'object', componentRef: null, collection: null });
    a.anchors.push({ anchorId: 'au', entityId: 'u', selection: selection('它') });
    b.mentions.push({ mentionId: 'mu', selection: selection('它'), basis: 'inference', rationale: 'Authored unresolved reference.',
      bindingStatus: 'bound', entityId: 'u', candidateEntityIds: [], reason: null });
  }
  b.mentions.push({ mentionId: 'gap', selection: options.wideGap ? selection('Gamma 与 Gamma') : selection('Gamma', 0), basis: 'explicit', rationale: 'Authored missing source object.',
    bindingStatus: options.ambiguousGap ? 'ambiguous' : 'unbound', entityId: null,
    candidateEntityIds: options.ambiguousGap ? ['e0', 'e1'] : [], reason: 'Authored unresolved catalog binding.' });
  if (options.overlappingGap) b.mentions.push({ ...structuredClone(b.mentions.at(-1)!), mentionId: 'gap-peer', selection: selection('Gamma 与 Gamma') });
  old.result('discovery').output = ` \n${JSON.stringify(a)}\r\n`; old.resealA();
  const originalBindingExecution = mentionBindingExecution(source, old.readA(), model);
  old.bindingReceipt.request = originalBindingExecution.request;
  old.bindingReceipt.producer = old.inspect(executor, originalBindingExecution.input);
  b.binding = JSON.parse(buildMentionBindingInput(source, old.readA().predecessor)).binding;
  old.result('binding').output = ` \n${JSON.stringify(b)}\r\n`; old.resealB();
  const discoveredEntitiesArchive = old.archive, refinedInspect = vi.fn(old.inspect.getMockImplementation()!);
  let refinementReceiptBytes: Buffer, refinementOutcomeBytes: Buffer, rebindingReceiptBytes: Buffer, rebindingOutcomeBytes: Buffer;
  const refinedRead = vi.fn((stage: 'refinement' | 'rebinding') => stage === 'refinement'
    ? { receiptBytes: Buffer.from(refinementReceiptBytes), outcomeBytes: Buffer.from(refinementOutcomeBytes) }
    : { receiptBytes: Buffer.from(rebindingReceiptBytes), outcomeBytes: Buffer.from(rebindingOutcomeBytes) });
  const refinedEntitiesArchive: RefinedEntitiesArchivePort = { read: refinedRead, inspect: refinedInspect };
  let refinementReference: { receiptId: string; receiptRef: ReturnType<typeof discoveryRef> };
  let rebindingReference: { receiptId: string; receiptRef: ReturnType<typeof discoveryRef> };
  const references = () => ({
    sourcePlan: { receiptId: old.plan.sourcePlanReceipt.receiptId, receiptRef: discoveryRef(discoveryBytes(old.plan.sourcePlanReceipt)) },
    discovery: old.discoveryRef, binding: old.bindingRef, refinement: refinementReference, rebinding: rebindingReference,
  });
  const readBase = () => readRefinedEntitiesBaseEvidence(source, model, references(), { sourcePlanArchive, discoveredEntitiesArchive });
  const base = readBase(), refinementExecution = entityRefinementExecution(source, model, base, refinedEntitiesArchive);
  const mapEntity = (entityId: string) => `next-${entityId}`;
  const refinementResponse: EntityRefinementResponse = { responseKind: 'entity-refinement', schemaVersion: 3,
    binding: JSON.parse(buildEntityRefinementInput(source, base.predecessor)).binding,
    entities: a.entities.map(entity => ({ ...structuredClone(entity), entityId: mapEntity(entity.entityId),
      possibleEntityIds: entity.possibleEntityIds.map(mapEntity),
      componentRef: entity.componentRef ? { ...entity.componentRef, entityId: mapEntity(entity.componentRef.entityId),
        anchorIds: entity.componentRef.anchorIds.map(id => `next-${id}`) } : null,
      collection: entity.collection ? { ...entity.collection, memberEntityIds: entity.collection.memberEntityIds.map(mapEntity),
        anchorIds: entity.collection.anchorIds.map(id => `next-${id}`) } : null })),
    anchors: a.anchors.map(anchor => ({ ...structuredClone(anchor), anchorId: `next-${anchor.anchorId}`, entityId: mapEntity(anchor.entityId) })),
    dispositions: old.plan.sourcePlanResponse.objects.map(object => ({ sourcePlanObjectId: object.objectId, dispositionKind: 'retained',
      entityIds: ['next-e0'], rationale: 'Authored first coordination of an independent plan object with a source-only catalog.',
      selections: structuredClone(object.anchors) })),
    entityDispositions: a.entities.map(entity => ({ previousEntityId: entity.entityId, dispositionKind: 'retained',
      entityIds: [mapEntity(entity.entityId)], rationale: 'Authored retained mapping, not source truth.',
      selections: [structuredClone(a.anchors.find(anchor => anchor.entityId === entity.entityId)!.selection)] })),
    bindingGapDispositions: b.mentions.filter(mention => mention.bindingStatus !== 'bound').map(mention => ({ previousMentionId: mention.mentionId, resolutionKind: 'mapped',
      targets: [{ entityId: 'next-gamma', selection: selection('Gamma', 0) }],
      rationale: 'Authored gap mapping intent, not a semantic conclusion.', selections: [structuredClone(mention.selection)] })) };
  refinementResponse.entities.push({ entityId: 'next-gamma', label: 'Gamma', description: 'Authored newly discovered Gamma object.', qualifiers: [],
    identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentRef: null, collection: null });
  refinementResponse.anchors.push({ anchorId: 'next-agamma', entityId: 'next-gamma', selection: selection('Gamma', 0) });
  const nativeResult = (output: string) => ({ ok: true, output, durationMs: 5, numTurns: 1, fullNumTurns: 1,
    numSubAgents: 0, attemptCount: 1, stopReason: executor === 'codex' ? 'end_turn' : 'stop', retainedTrace: { authored: true } });
  const refinementNative = { archiveKind: 'knowledge-entity-refinement-native', schemaVersion: 1,
    receiptId: discoveryUid(8), attemptId: discoveryUid(9), outcome: { outcomeKind: 'result',
      result: nativeResult(` \n${JSON.stringify(refinementResponse)}\r\n`) } as ExtractionOutcome };
  const refinementReceipt: EntityRefinementReceipt = { receiptKind: 'knowledge-entity-refinement-receipt', schemaVersion: 3,
    receiptId: refinementNative.receiptId, attemptId: refinementNative.attemptId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    request: refinementExecution.request, producer: refinementExecution.producer, requestDigest: discoveryHash('pending'),
    nativeRef: discoveryRef(discoveryBytes(refinementNative)), startedAt: '2026-10-24T00:00:04Z', finishedAt: '2026-10-24T00:00:05Z' };
  const resealRefinement = () => {
    refinementOutcomeBytes = discoveryBytes(refinementNative); refinementReceipt.nativeRef = discoveryRef(refinementOutcomeBytes);
    refinementReceipt.requestDigest = entityRefinementRequestDigest(refinementReceipt); refinementReceiptBytes = discoveryBytes(refinementReceipt);
    refinementReference = { receiptId: refinementReceipt.receiptId, receiptRef: discoveryRef(refinementReceiptBytes) }; return refinementReference;
  };
  resealRefinement();
  const readRefinement = () => readEntityRefinementEvidence(source, model, refinementReference, refinedEntitiesArchive, readBase());
  const refinement = readRefinement(), rebindingExecution = mentionRebindingExecution(source, model, refinement, refinedEntitiesArchive);
  const mapMention = (mentionId: string) => `next-${mentionId}`;
  const rebindingResponse: MentionRebindingResponse = { responseKind: 'mention-rebinding', schemaVersion: 3,
    binding: JSON.parse(buildMentionRebindingInput(source, base.predecessor, refinement.predecessor)).binding,
    mentions: b.mentions.filter(mention => mention.mentionId !== 'gap-peer').map(mention => ({ ...structuredClone(mention), mentionId: mapMention(mention.mentionId),
      selection: mention.mentionId === 'gap' ? selection('Gamma', 0) : structuredClone(mention.selection),
      bindingStatus: 'bound', entityId: mention.entityId ? mapEntity(mention.entityId) : 'next-gamma', candidateEntityIds: [], reason: null })),
    identitySupports: b.identitySupports.map(support => ({ ...support, entityId: mapEntity(support.entityId), mentionIds: support.mentionIds.map(mapMention) })),
    mentionDispositions: b.mentions.map(mention => ({ previousMentionId: mention.mentionId,
      dispositionKind: mention.bindingStatus === 'bound' ? 'retained' : 'corrected', mentionIds: [mapMention(mention.mentionId === 'gap-peer' ? 'gap' : mention.mentionId)],
      rationale: 'Authored mapping of an old mention.', selections: [structuredClone(mention.selection)] })),
    supportDispositions: b.identitySupports.map(support => ({ previousSupport: { entityId: support.entityId, supportKind: support.supportKind },
      dispositionKind: 'retained', supports: [{ entityId: mapEntity(support.entityId), supportKind: support.supportKind }],
      rationale: 'Authored mapping of an old support.', selections: [selection('该组')] })) };
  const rebindingNative = { archiveKind: 'knowledge-mention-rebinding-native', schemaVersion: 1,
    receiptId: discoveryUid(10), attemptId: discoveryUid(11), outcome: { outcomeKind: 'result',
      result: nativeResult(` \n${JSON.stringify(rebindingResponse)}\r\n`) } as ExtractionOutcome };
  const rebindingReceipt: MentionRebindingReceipt = { receiptKind: 'knowledge-mention-rebinding-receipt', schemaVersion: 3,
    receiptId: rebindingNative.receiptId, attemptId: rebindingNative.attemptId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    request: rebindingExecution.request, producer: rebindingExecution.producer, requestDigest: discoveryHash('pending'),
    nativeRef: discoveryRef(discoveryBytes(rebindingNative)), startedAt: '2026-10-24T00:00:06Z', finishedAt: '2026-10-24T00:00:07Z' };
  const resealRebinding = () => {
    rebindingOutcomeBytes = discoveryBytes(rebindingNative); rebindingReceipt.nativeRef = discoveryRef(rebindingOutcomeBytes);
    rebindingReceipt.requestDigest = mentionRebindingRequestDigest(rebindingReceipt); rebindingReceiptBytes = discoveryBytes(rebindingReceipt);
    rebindingReference = { receiptId: rebindingReceipt.receiptId, receiptRef: discoveryRef(rebindingReceiptBytes) }; return rebindingReference;
  };
  resealRebinding(); old.inspect.mockClear(); old.read.mockClear(); refinedInspect.mockClear(); refinedRead.mockClear();
  return { old, source, model, sourcePlanArchive, discoveredEntitiesArchive, refinedEntitiesArchive, references, readBase, readRefinement,
    readRebinding: () => readMentionRebindingEvidence(source, model, rebindingReference, refinedEntitiesArchive, readRefinement()),
    refinementExecution, refinementReceipt, refinementNative, refinementResponse, rebindingExecution, rebindingReceipt, rebindingNative, rebindingResponse,
    resealRefinement, resealRebinding, refinedRead, refinedInspect,
    get refinementRef() { return refinementReference; }, get rebindingRef() { return rebindingReference; },
    result(stage: 'refinement' | 'rebinding') {
      const outcome = stage === 'refinement' ? refinementNative.outcome : rebindingNative.outcome;
      if (outcome.outcomeKind !== 'result') throw new Error('Authored fixture is not a native result.'); return outcome.result;
    },
    bytesRefinement: () => ({ receiptBytes: Buffer.from(refinementReceiptBytes), outcomeBytes: Buffer.from(refinementOutcomeBytes) }),
    bytesRebinding: () => ({ receiptBytes: Buffer.from(rebindingReceiptBytes), outcomeBytes: Buffer.from(rebindingOutcomeBytes) }),
  };
}
