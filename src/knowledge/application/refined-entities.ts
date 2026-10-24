import { createHash } from 'node:crypto';
import type { KnowledgeActor } from '../contracts.js';
import { EntityAnalysisDraftSchema, type EntityAnalysisStore, type EntityAnalysisWrite } from '../entities/contracts.js';
import { mapEntityIdentity } from '../entities/identity.js';
import { validateEntityAnalysis, validateEntityMentionSelection } from '../entities/validation.js';
import { canonicalJson } from '../store.js';
import { BoundKnowledgeSourceSchema } from '../extraction/bound-catalog.js';
import type { EvidenceStore } from '../extraction/evidence.js';
import type { SourcePlanArchivePort } from '../extraction/source-plan-evidence.js';
import type { EntityDiscoveryArchivePort } from '../extraction/discovered-entities-evidence.js';
import { readRefinedEntitiesBaseEvidence, entityRefinementExecution, readEntityRefinementEvidence,
  mentionRebindingExecution, readMentionRebindingEvidence, type RefinedEntitiesArchivePort,
  type RefinedEntitiesBaseReferences, type RefinedEntitiesModel, type EntityRefinementReference,
  type MentionRebindingReference } from '../extraction/refined-entities-evidence.js';

interface RefinedEntitiesPorts {
  evidence: EvidenceStore;
  entities: EntityAnalysisStore;
  actor: KnowledgeActor;
  sourcePlanArchive?: SourcePlanArchivePort;
  discoveredEntitiesArchive?: EntityDiscoveryArchivePort;
  refinedEntitiesArchive?: RefinedEntitiesArchivePort;
}
export interface RefinedEntitiesSource { snapshotId: string; sourceVersion: string }
export interface RefinedEntitiesContextReferences extends RefinedEntitiesBaseReferences { refinement: EntityRefinementReference }
export interface RefinedEntitiesReferences extends RefinedEntitiesContextReferences { rebinding: MentionRebindingReference }
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

/** One final B′ receipt owns one initial analysis. Changed evidence must conflict under these stable IDs. */
function importId(receiptId: string, role: string, localId: string | null = null): string {
  const bytes = createHash('sha256').update(canonicalJson({ identityVersion: 'knowledge-refined-entities-import/v1',
    receiptId, role, localId })).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readBase(ports: RefinedEntitiesPorts, selection: RefinedEntitiesSource,
  model: RefinedEntitiesModel, references: RefinedEntitiesBaseReferences) {
  if (!ports.sourcePlanArchive) throw new Error('Source plan archive unavailable.');
  if (!ports.discoveredEntitiesArchive) throw new Error('Discovered entities archive unavailable.');
  if (!ports.refinedEntitiesArchive) throw new Error('Refined entities archive unavailable.');
  const saved = ports.evidence.read(selection.snapshotId, selection.sourceVersion);
  if (saved.status !== 'available') throw new Error('Refined entities source unavailable.');
  const window = saved.window;
  const source = BoundKnowledgeSourceSchema.parse({ snapshotId: window.snapshotId, sourceVersion: window.sourceVersion,
    excerpts: window.excerpts, limitations: window.limitations });
  if (source.snapshotId !== selection.snapshotId || source.sourceVersion !== selection.sourceVersion) {
    throw new Error('Refined entities source binding mismatch.');
  }
  const base = readRefinedEntitiesBaseEvidence(source, model, references, {
    sourcePlanArchive: ports.sourcePlanArchive, discoveredEntitiesArchive: ports.discoveredEntitiesArchive });
  return { source, base, archive: ports.refinedEntitiesArchive };
}

/** Authenticate current plan→A→B and materialize the actual A′ factory input without constructing an executor. */
export function readRefinedEntitiesContext(ports: RefinedEntitiesPorts, selection: RefinedEntitiesSource,
  model: RefinedEntitiesModel, references: RefinedEntitiesBaseReferences) {
  const { source, base, archive } = readBase(ports, selection, model, references);
  const execution = entityRefinementExecution(source, model, base, archive);
  return structuredClone({ source, base, execution, semanticStatus: 'not_reviewed' as const });
}

/** A′ disposition uncertainty blocks B′; native and structural failures retain their originals on the reader error. */
export function readRefinedEntitiesRebindingContext(ports: RefinedEntitiesPorts, selection: RefinedEntitiesSource,
  model: RefinedEntitiesModel, references: RefinedEntitiesContextReferences) {
  const { source, base, archive } = readBase(ports, selection, model, references);
  const refinement = readEntityRefinementEvidence(source, model, references.refinement, archive, base);
  if (refinement.checked.dispositionIssues.length) {
    return { status: 'blocked' as const, semanticStatus: 'not_reviewed' as const, source, base, refinement,
      issues: refinement.checked.dispositionIssues };
  }
  const execution = mentionRebindingExecution(source, model, refinement, archive);
  return structuredClone({ status: 'ready' as const, semanticStatus: 'not_reviewed' as const, source, base, refinement, execution });
}

/** Re-authenticate all five originals and write only the complete final analysis, with no extraction run or K effects. */
export function importRefinedEntityAnalysis(ports: RefinedEntitiesPorts, selection: RefinedEntitiesSource,
  model: RefinedEntitiesModel, references: RefinedEntitiesReferences, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { source, base, archive } = readBase(ports, selection, model, references);
  const refinement = readEntityRefinementEvidence(source, model, references.refinement, archive, base);
  if (refinement.checked.dispositionIssues.length) {
    return { status: 'blocked' as const, semanticStatus: 'not_reviewed' as const, base, refinement,
      issues: refinement.checked.dispositionIssues };
  }
  const rebinding = readMentionRebindingEvidence(source, model, references.rebinding, archive, refinement);
  if (rebinding.checked.status !== 'checked') {
    return { status: 'blocked' as const, semanticStatus: 'not_reviewed' as const, base, refinement, rebinding,
      issues: rebinding.checked.issues };
  }
  const admission = rebinding.checked.admission;
  if (admission.status !== 'ready') {
    return { status: 'blocked' as const, semanticStatus: 'not_reviewed' as const, base, refinement, rebinding,
      issues: admission.issues };
  }
  const receiptId = rebinding.receipt.receiptId;
  const analysisId = importId(receiptId, 'analysis'), revisionId = importId(receiptId, 'revision'), requestId = importId(receiptId, 'request');
  const chainDigest = digest({ importVersion: 'knowledge-refined-entities-import/v1', actor: ports.actor,
    snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    sourcePlan: { receiptId: base.sourcePlan.receipt.receiptId, receiptRef: base.sourcePlan.receiptRef },
    discovery: { receiptId: base.discovery.receipt.receiptId, receiptRef: base.discovery.receiptRef },
    binding: { receiptId: base.binding.receipt.receiptId, receiptRef: base.binding.receiptRef },
    refinement: { receiptId: refinement.receipt.receiptId, receiptRef: refinement.receiptRef },
    rebinding: { receiptId, receiptRef: rebinding.receiptRef } });
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
  if (problems.length) throw new Error(`Refined entities composition failed: ${[...new Set(problems)].join(',')}`);
  const actor: KnowledgeActor = { actorKind: 'agent', actorId: 'extractor:entity-catalog-revision', executionRef: chainDigest };
  const write: EntityAnalysisWrite = { requestId, analysisId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { ...draft, revisionId, revisedAt: rebinding.receipt.finishedAt, revisedBy: actor,
      revisionReason: '从来源清单、实体发现、绑定与一次目录修订原件合成，等待核对' } };
  signal?.throwIfAborted();
  const receipt = ports.entities.write(write, actor);
  return { status: 'committed' as const, semanticStatus: 'not_reviewed' as const, chainDigest,
    analysisId, revisionId, receipt, write, base, refinement, rebinding };
}
