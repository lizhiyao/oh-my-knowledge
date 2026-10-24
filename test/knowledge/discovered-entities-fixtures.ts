import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { ExecutorInput } from '../../src/executors/contracts/ports.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { sourcePlanExecution, sourcePlanRequestDigest, readSourcePlanEvidence, type SourcePlanArchivePort,
  type SourcePlanReceipt } from '../../src/knowledge/extraction/source-plan-evidence.js';
import type { KnowledgeSourcePlanSource } from '../../src/knowledge/extraction/source-plan.js';
import { buildEntityDiscoveryInput } from '../../src/knowledge/extraction/entity-discovery.js';
import { buildMentionBindingInput } from '../../src/knowledge/extraction/mention-binding.js';
import type { ExtractionNativeResult, ExtractionOutcome } from '../../src/knowledge/extraction/runs.js';
import { entityDiscoveryExecution, mentionBindingExecution, entityDiscoveryRequestDigest, mentionBindingRequestDigest,
  readEntityDiscoveryEvidence, readMentionBindingEvidence, type EntityDiscoveryArchivePort,
  type EntityDiscoveryModel, type EntityDiscoveryReceipt, type MentionBindingReceipt } from '../../src/knowledge/extraction/discovered-entities-evidence.js';

export const discoveryHash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const discoveryBytes = (value: unknown) => Buffer.from(JSON.stringify(value));
export const discoveryRef = (value: Uint8Array) => ({ bytes: value.byteLength, digest: discoveryHash(value) });
export const discoveryUid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const authoredModel = { executor: 'codex' as const, model: 'authored-model', timeoutMs: 2000, maxOutputTokens: 1024 };
const authoredProducer = (executor: string, input: ExecutorInput) => ({ producerId: 'authored-discovered-entities/v1',
  producerRevision: discoveryHash('authored-only producer'), sourceChannels: [{ channel: 'authored-native-json', maxBytes: 1024 * 1024 }],
  maxOutcomeJsonBytes: 2 * 1024 * 1024,
  proof: { requestDigest: discoveryHash(JSON.stringify({ executor, input })), scope: 'authored-only; not a native invocation' } });
const authoredNativeResult = (output: string, executor: string): ExtractionNativeResult => ({ ok: true, output, durationMs: 5,
  numTurns: 1, fullNumTurns: 1, numSubAgents: 0, attemptCount: 1,
  stopReason: executor === 'codex' ? 'end_turn' : 'stop', retainedTrace: { authored: ['all', 'native', 'fields'] } });
type AuthoredPlanObject = { objectId: string; quote: string; occurrence: number | null };

/** An authenticated in-memory source-plan original, never a real model return or semantic truth. */
export function authoredDiscoverySourcePlan(source: KnowledgeSourcePlanSource, model: EntityDiscoveryModel = authoredModel,
  objects: AuthoredPlanObject[] = [{ objectId: 'source-object', quote: source.excerpts[0].text, occurrence: null }]) {
  const execution = sourcePlanExecution(source, model);
  const sourcePlanResponse = { responseKind: 'knowledge-source-plan', schemaVersion: 2,
    snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    objects: objects.map(object => ({ objectId: object.objectId, meaning: object.quote,
      planningRole: 'entity_candidate', qualificationBasis: 'Authored untrusted planning judgment.',
      referentKind: 'object', identityStatus: 'proposed', identityBasis: 'Authored local source identity claim.',
      typeBasis: 'Authored type claim, not semantic truth.',
      anchors: [{ evidenceRef: source.excerpts[0].evidenceRef, quote: object.quote, occurrence: object.occurrence }],
      uncertainties: [], sharedScope: null })), materials: [] };
  const sourcePlanNative = { archiveKind: 'knowledge-source-plan-native', schemaVersion: 1,
    receiptId: discoveryUid(6), attemptId: discoveryUid(7), outcome: { outcomeKind: 'result',
      result: authoredNativeResult(` \n${JSON.stringify(sourcePlanResponse)}\r\n`, model.executor) } as ExtractionOutcome };
  const sourcePlanReceipt: SourcePlanReceipt = { receiptKind: 'knowledge-source-plan-receipt', schemaVersion: 1,
    receiptId: sourcePlanNative.receiptId, attemptId: sourcePlanNative.attemptId,
    snapshotId: source.snapshotId, sourceVersion: source.sourceVersion, request: execution.request,
    producer: authoredProducer(model.executor, execution.input), requestDigest: discoveryHash('pending'),
    nativeRef: discoveryRef(discoveryBytes(sourcePlanNative)),
    startedAt: '2026-10-23T23:59:58Z', finishedAt: '2026-10-23T23:59:59Z' };
  let receiptBytes: Buffer, outcomeBytes: Buffer;
  const resealSourcePlan = () => {
    outcomeBytes = discoveryBytes(sourcePlanNative); sourcePlanReceipt.nativeRef = discoveryRef(outcomeBytes);
    sourcePlanReceipt.requestDigest = sourcePlanRequestDigest(sourcePlanReceipt); receiptBytes = discoveryBytes(sourcePlanReceipt);
    return { receiptId: sourcePlanReceipt.receiptId, receiptRef: discoveryRef(receiptBytes) };
  };
  let sourcePlanRef = resealSourcePlan();
  const sourcePlanArchive: SourcePlanArchivePort = { read: () => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(outcomeBytes) }),
    inspect: vi.fn(authoredProducer) };
  const readPlan = () => readSourcePlanEvidence(source, model, sourcePlanRef, sourcePlanArchive);
  const sourcePlan = readPlan();
  const planPredecessor = { receiptId: sourcePlan.receipt.receiptId, receiptRef: sourcePlan.receiptRef,
    receiptRaw: sourcePlan.receiptRaw, rawOutput: sourcePlan.rawOutput };
  return { sourcePlan, sourcePlanRef, sourcePlanArchive, sourcePlanResponse, sourcePlanNative, sourcePlanReceipt, planPredecessor,
    readPlan, resealSourcePlan: () => { sourcePlanRef = resealSourcePlan(); return sourcePlanRef; } };
}

/** In-memory authored originals only: no real producer, invocation, filesystem, network or semantic evidence. */
export function discoveredEntitiesFixture(executor: 'codex' | 'openai-api' = 'codex', text = 'Alpha 使用 Beta') {
  const source = { snapshotId: discoveryUid(1), sourceVersion: discoveryHash('authored discovery source'),
    excerpts: [{ evidenceRef: 'record-1', recordIndex: 1, eventKind: 'message' as const, role: 'assistant' as const, text }],
    limitations: ['Authored source assertion; not independently verified.'] };
  const model = { ...authoredModel, executor }, plan = authoredDiscoverySourcePlan(source, model,
    [{ objectId: 'source-object', quote: 'Alpha', occurrence: null }]);
  const { sourcePlan, sourcePlanRef, sourcePlanArchive, planPredecessor } = plan;
  const producer = authoredProducer, inspect = vi.fn(producer);
  const nativeResult = (output: string) => authoredNativeResult(output, executor);
  const discoveryResponse = { responseKind: 'entity-discovery', schemaVersion: 2,
    binding: JSON.parse(buildEntityDiscoveryInput(source, planPredecessor)).binding as Record<string, unknown>,
    entities: ['Alpha', 'Beta'].map((label, index) => ({ entityId: `e${index}`, label, description: `Authored object ${label}`,
      qualifiers: [] as string[], identityStatus: 'proposed' as 'proposed' | 'unresolved', possibleEntityIds: [] as string[], uncertainties: [] as string[],
      referentKind: 'object' as const, componentRef: null, collection: null })),
    dispositions: [{ sourcePlanObjectId: 'source-object', dispositionKind: 'retained' as 'retained' | 'corrected' | 'excluded' | 'undetermined',
      entityIds: ['e0'], rationale: 'Authored disposition; source-only Beta remains independently discovered.',
      selections: [{ evidenceRef: 'record-1', quote: 'Alpha', occurrence: null as number | null }] }],
    anchors: ['Alpha', 'Beta'].map((quote, index) => ({ anchorId: `a${index}`, entityId: `e${index}`,
      selection: { evidenceRef: 'record-1', quote, occurrence: null as number | null } })) };
  const discoveryExecution = entityDiscoveryExecution(source, model, sourcePlan);
  const discoveryNative = { archiveKind: 'knowledge-entity-discovery-native', schemaVersion: 1, receiptId: discoveryUid(2), attemptId: discoveryUid(3),
    outcome: { outcomeKind: 'result', result: nativeResult(` \n${JSON.stringify(discoveryResponse)}\r\n`) } as ExtractionOutcome };
  const discoveryReceipt: EntityDiscoveryReceipt = { receiptKind: 'knowledge-entity-discovery-receipt', schemaVersion: 2,
    receiptId: discoveryNative.receiptId, attemptId: discoveryNative.attemptId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    request: discoveryExecution.request, producer: producer(executor, discoveryExecution.input), requestDigest: discoveryHash('pending'),
    nativeRef: discoveryRef(discoveryBytes(discoveryNative)), startedAt: '2026-10-24T00:00:00Z', finishedAt: '2026-10-24T00:00:01Z' };
  let discoveryOutcomeBytes: Buffer, discoveryReceiptBytes: Buffer, discoveryReference: { receiptId: string; receiptRef: ReturnType<typeof discoveryRef> };
  const resealA = () => {
    discoveryOutcomeBytes = discoveryBytes(discoveryNative); discoveryReceipt.nativeRef = discoveryRef(discoveryOutcomeBytes);
    discoveryReceipt.requestDigest = entityDiscoveryRequestDigest(discoveryReceipt); discoveryReceiptBytes = discoveryBytes(discoveryReceipt);
    discoveryReference = { receiptId: discoveryReceipt.receiptId, receiptRef: discoveryRef(discoveryReceiptBytes) }; return discoveryReference;
  };
  resealA();
  let bindingOutcomeBytes: Buffer, bindingReceiptBytes: Buffer;
  const read = vi.fn((stage: 'discovery' | 'binding') => stage === 'discovery'
    ? { receiptBytes: Buffer.from(discoveryReceiptBytes), outcomeBytes: Buffer.from(discoveryOutcomeBytes) }
    : { receiptBytes: Buffer.from(bindingReceiptBytes), outcomeBytes: Buffer.from(bindingOutcomeBytes) });
  const archive: EntityDiscoveryArchivePort = { read, inspect };
  const readA = () => readEntityDiscoveryEvidence(source, model, discoveryReference, archive, sourcePlan);
  const discovery = readA(), bindingExecution = mentionBindingExecution(source, discovery, model);
  const bindingResponse = { responseKind: 'mention-binding', schemaVersion: 2,
    binding: JSON.parse(buildMentionBindingInput(source, discovery.predecessor)).binding as Record<string, unknown>,
    mentions: ['Alpha', 'Beta'].map((quote, index) => ({ mentionId: `m${index}`, selection: { evidenceRef: 'record-1', quote, occurrence: null as number | null },
      basis: 'explicit' as const, rationale: 'Authored explicit mention.', bindingStatus: 'bound' as 'bound' | 'ambiguous' | 'unbound',
      entityId: `e${index}` as string | null, candidateEntityIds: [] as string[], reason: null as string | null })), identitySupports: [] };
  const bindingNative = { archiveKind: 'knowledge-mention-binding-native', schemaVersion: 1, receiptId: discoveryUid(4), attemptId: discoveryUid(5),
    outcome: { outcomeKind: 'result', result: nativeResult(` \n${JSON.stringify(bindingResponse)}\r\n`) } as ExtractionOutcome };
  const bindingReceipt: MentionBindingReceipt = { receiptKind: 'knowledge-mention-binding-receipt', schemaVersion: 2,
    receiptId: bindingNative.receiptId, attemptId: bindingNative.attemptId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    request: bindingExecution.request, producer: producer(executor, bindingExecution.input), requestDigest: discoveryHash('pending'),
    nativeRef: discoveryRef(discoveryBytes(bindingNative)), startedAt: '2026-10-24T00:00:02Z', finishedAt: '2026-10-24T00:00:03Z' };
  let bindingReference: { receiptId: string; receiptRef: ReturnType<typeof discoveryRef> };
  const resealB = () => {
    bindingOutcomeBytes = discoveryBytes(bindingNative); bindingReceipt.nativeRef = discoveryRef(bindingOutcomeBytes);
    bindingReceipt.requestDigest = mentionBindingRequestDigest(bindingReceipt); bindingReceiptBytes = discoveryBytes(bindingReceipt);
    bindingReference = { receiptId: bindingReceipt.receiptId, receiptRef: discoveryRef(bindingReceiptBytes) }; return bindingReference;
  };
  resealB(); inspect.mockClear(); read.mockClear();
  const result = (stage: 'discovery' | 'binding') => {
    const outcome = stage === 'discovery' ? discoveryNative.outcome : bindingNative.outcome;
    if (outcome.outcomeKind !== 'result') throw new Error('Authored fixture is not a native result.');
    return outcome.result;
  };
  return { source, model, sourcePlan, sourcePlanRef, sourcePlanArchive, plan, planPredecessor, archive, inspect, read, discoveryReceipt, bindingReceipt, discoveryNative, bindingNative,
    discoveryResponse, bindingResponse, discoveryExecution, bindingExecution, resealA, resealB, readA, result,
    get discoveryRef() { return discoveryReference; }, get bindingRef() { return bindingReference; },
    readB: () => readMentionBindingEvidence(source, readA(), model, bindingReference, archive),
    bytesA: () => ({ receiptBytes: Buffer.from(discoveryReceiptBytes), outcomeBytes: Buffer.from(discoveryOutcomeBytes) }),
    bytesB: () => ({ receiptBytes: Buffer.from(bindingReceiptBytes), outcomeBytes: Buffer.from(bindingOutcomeBytes) }),
    canonicalSnapshot: () => canonicalJson({ source, discoveryReceipt, bindingReceipt, discoveryNative, bindingNative }) };
}
