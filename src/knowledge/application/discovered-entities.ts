import { createHash } from 'node:crypto';
import type { KnowledgeActor } from '../contracts.js';
import { EntityAnalysisDraftSchema, type EntityAnalysisStore, type EntityAnalysisWrite } from '../entities/contracts.js';
import { mapEntityIdentity } from '../entities/identity.js';
import { validateEntityAnalysis, validateEntityMentionSelection } from '../entities/validation.js';
import { canonicalJson } from '../store.js';
import { BoundKnowledgeSourceSchema, type BoundKnowledgeCatalog } from '../extraction/bound-catalog.js';
import type { EvidenceStore } from '../extraction/evidence.js';
import { readEntityDiscoveryEvidence, readMentionBindingEvidence, type EntityDiscoveryArchivePort,
  type EntityDiscoveryModel, type EntityDiscoveryReference, type MentionBindingReference } from '../extraction/discovered-entities-evidence.js';

interface DiscoveredEntitiesPorts {
  evidence: EvidenceStore;
  entities: EntityAnalysisStore;
  actor: KnowledgeActor;
  discoveredEntitiesArchive?: EntityDiscoveryArchivePort;
}
export interface DiscoveredEntitiesSource { snapshotId: string; sourceVersion: string }
export interface DiscoveredEntitiesContextReferences { discovery: EntityDiscoveryReference }
export interface DiscoveredEntitiesReferences extends DiscoveredEntitiesContextReferences { binding: MentionBindingReference }
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

/** Local to one binding receipt. These IDs never infer identity across windows or receipts. */
function importId(receiptId: string, role: string, localId: string | null = null): string {
  const bytes = createHash('sha256').update(canonicalJson({ identityVersion: 'knowledge-discovered-entities-import/v1',
    receiptId, role, localId })).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readDiscovery(ports: DiscoveredEntitiesPorts, selection: DiscoveredEntitiesSource,
  model: EntityDiscoveryModel, references: DiscoveredEntitiesContextReferences) {
  if (!ports.discoveredEntitiesArchive) throw new Error('Discovered entities archive unavailable.');
  const saved = ports.evidence.read(selection.snapshotId, selection.sourceVersion);
  if (saved.status !== 'available') throw new Error('Discovered entities source unavailable.');
  const window = saved.window;
  const source = BoundKnowledgeSourceSchema.parse({ snapshotId: window.snapshotId, sourceVersion: window.sourceVersion,
    excerpts: window.excerpts, limitations: window.limitations });
  if (source.snapshotId !== selection.snapshotId || source.sourceVersion !== selection.sourceVersion) {
    throw new Error('Discovered entities source binding mismatch.');
  }
  const discovery = readEntityDiscoveryEvidence(source, model, references.discovery, ports.discoveredEntitiesArchive);
  return { window, source, discovery };
}

/** Authenticate source-only A before reserving B; this only reads existing originals. */
export function readDiscoveredEntitiesContext(ports: DiscoveredEntitiesPorts, selection: DiscoveredEntitiesSource,
  model: EntityDiscoveryModel, references: DiscoveredEntitiesContextReferences) {
  const { source, discovery } = readDiscovery(ports, selection, model, references);
  return structuredClone({ source, discovery });
}

/** Publication and the readonly K handoff must reconstruct the same initial write intent. */
function prepareDiscoveredEntityAnalysis(ports: DiscoveredEntitiesPorts, selection: DiscoveredEntitiesSource,
  model: EntityDiscoveryModel, references: DiscoveredEntitiesReferences) {
  const { window, source, discovery } = readDiscovery(ports, selection, model, references);
  const binding = readMentionBindingEvidence(source, discovery, model, references.binding, ports.discoveredEntitiesArchive!);
  if (binding.checked.status !== 'checked') {
    return { status: 'blocked' as const, semanticStatus: 'not_reviewed' as const, discovery, binding, issues: binding.checked.issues };
  }
  const admission = binding.checked.admission;
  if (admission.status !== 'ready') {
    return { status: 'blocked' as const, semanticStatus: 'not_reviewed' as const, discovery, binding, issues: admission.issues };
  }
  const receiptId = binding.receipt.receiptId;
  // Stable logical IDs make changed bytes under an existing receipt conflict instead of creating a new history.
  const analysisId = importId(receiptId, 'analysis'), revisionId = importId(receiptId, 'revision');
  const requestId = importId(receiptId, 'request');
  const chainDigest = digest({ importVersion: 'knowledge-discovered-entities-import/v3', actor: ports.actor,
    discovery: { receiptId: discovery.receipt.receiptId, receiptRef: discovery.receiptRef },
    binding: { receiptId, receiptRef: binding.receiptRef } });
  const entityIds = new Map(admission.analysis.entities.map(entity => [entity.entityId, importId(receiptId, 'entity', entity.entityId)]));
  const mentionIds = new Map(admission.analysis.mentions.map(mention => [mention.mentionId, importId(receiptId, 'mention', mention.mentionId)]));
  const draft = EntityAnalysisDraftSchema.parse({
    entities: admission.analysis.entities.map(entity => mapEntityIdentity(entity, entityIds, mentionIds)),
    mentions: admission.analysis.mentions.map(mention => ({ ...mention,
      mentionId: mentionIds.get(mention.mentionId)!, entityId: entityIds.get(mention.entityId)! })),
    limitations: source.limitations,
  });
  const problems = [...validateEntityAnalysis(draft),
    ...draft.mentions.flatMap(mention => validateEntityMentionSelection(mention.selection, source.excerpts))];
  if (problems.length) throw new Error(`Discovered entities composition failed: ${[...new Set(problems)].join(',')}`);
  const actor: KnowledgeActor = { actorKind: 'agent', actorId: 'extractor:entity-discovery-binding', executionRef: chainDigest };
  const write: EntityAnalysisWrite = { requestId, analysisId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { ...draft, revisionId, revisedAt: binding.receipt.finishedAt, revisedBy: actor,
      revisionReason: '从独立实体发现与提及绑定原件合成，等待核对' } };
  return { status: 'ready' as const, window, source, chainDigest, analysisId, revisionId, actor, write, discovery, binding };
}

/** Authenticate both originals and the actual persisted initial revision, without writing or generating anything. */
export function readDiscoveredEntitiesKnowledgeContext(ports: DiscoveredEntitiesPorts, selection: DiscoveredEntitiesSource,
  model: EntityDiscoveryModel, references: DiscoveredEntitiesReferences) {
  const prepared = prepareDiscoveredEntityAnalysis(ports, selection, model, references);
  if (prepared.status !== 'ready') throw new Error('Discovered entities knowledge requires a ready initial analysis.');
  const { window, source, chainDigest, analysisId, revisionId, actor, write, discovery, binding } = prepared;
  const ids = [discovery.receipt, binding.receipt].flatMap(receipt => [receipt.receiptId, receipt.attemptId]);
  if (new Set(ids).size !== ids.length) throw new Error('Discovered entities knowledge requires independent receipt and attempt identities.');
  const history = ports.entities.read(analysisId), revision = history.revisions[0], receipt = history.receipts[0];
  const expectedReceipt = { requestId: write.requestId, commandDigest: digest({ actor, command: write }),
    committedGeneration: 1, revisionId };
  if (history.analysisId !== analysisId || history.snapshotId !== source.snapshotId || history.sourceVersion !== source.sourceVersion
    || !revision || canonicalJson(revision) !== canonicalJson(write.revision)
    || !receipt || canonicalJson(receipt) !== canonicalJson(expectedReceipt)) {
    throw new Error('Discovered entities analysis differs from the persisted initial revision or write intent.');
  }
  const catalog: BoundKnowledgeCatalog = { analysisId, revisionId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    entities: revision.entities, mentions: revision.mentions, limitations: revision.limitations };
  return structuredClone({ window, catalog, chainDigest, entityFinishedAt: binding.receipt.finishedAt,
    analysisId, revisionId, write, discovery, binding, semanticStatus: 'not_reviewed' as const });
}

/**
 * Import source-only A→B into one initial analysis, without an ExtractionRun.
 * Every retry re-authenticates both originals and reuses the same write intent; it never invokes a model.
 */
export function importDiscoveredEntityAnalysis(ports: DiscoveredEntitiesPorts, selection: DiscoveredEntitiesSource,
  model: EntityDiscoveryModel, references: DiscoveredEntitiesReferences, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const prepared = prepareDiscoveredEntityAnalysis(ports, selection, model, references);
  if (prepared.status !== 'ready') return prepared;
  const { chainDigest, analysisId, revisionId, actor, write, discovery, binding } = prepared;
  signal?.throwIfAborted();
  const receipt = ports.entities.write(write, actor);
  // The private driver archives this returned proof alongside its native receipts; no new storage schema is introduced.
  return { status: 'committed' as const, semanticStatus: 'not_reviewed' as const, chainDigest,
    analysisId, revisionId, receipt, write, discovery, binding };
}
