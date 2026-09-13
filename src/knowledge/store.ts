import { z } from 'zod';
import { EntityMentionSchema, EvidenceSelectionSchema, KnowledgeActorSchema, KnowledgeRevisionSchema } from './contracts.js';
import type { KnowledgeActor, KnowledgeRevision } from './contracts.js';

const id = z.string().min(1).max(256);
export const GroundingSchema = z.strictObject({
  revisionId: id,
  mentions: z.array(EntityMentionSchema).min(1).max(512),
  citations: z.array(z.strictObject({ evidenceLinkId: id, selection: EvidenceSelectionSchema })).min(1).max(512),
  sourceBindings: z.array(z.strictObject({ snapshotId: z.string().uuid(), sourceVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/), evidenceRefs: z.array(id).min(1) })).min(1),
  reuseRationale: z.string().min(1).max(4096),
  identityUncertainties: z.array(z.string().min(1).max(4096)).max(64),
});
export type KnowledgeGrounding = z.infer<typeof GroundingSchema>;
export const MaintenanceSchema = z.strictObject({
  revisionId: id, choice: z.enum(['retain', 'discard']),
  actor: KnowledgeActorSchema, at: z.iso.datetime({ offset: true }), reason: z.string().min(1).max(4096),
});
export type MaintenanceChoice = z.infer<typeof MaintenanceSchema>;
export const KnowledgeEnvelopeSchema = z.strictObject({
  storeKind: z.literal('knowledge-item-history'), schemaVersion: z.literal(1),
  namespace: id, knowledgeId: id, generation: z.number().int().positive(), writeHeadRevisionId: id,
  revisions: z.array(KnowledgeRevisionSchema).min(1),
  grounding: z.array(GroundingSchema).min(1),
  maintenance: z.array(MaintenanceSchema),
  receipts: z.array(z.strictObject({ requestId: id, commandDigest: z.string(), committedGeneration: z.number().int().positive(), revisionId: id })).min(1),
});
export type KnowledgeEnvelope = z.infer<typeof KnowledgeEnvelopeSchema>;
export type KnowledgeWrite = {
  requestId: string; knowledgeId: string; expectedGeneration: number;
} & (
  | { commandKind: 'append_revision'; expectedHeadRevisionId: string | null; revision: KnowledgeRevision; grounding: KnowledgeGrounding }
  | { commandKind: 'record_maintenance'; maintenance: MaintenanceChoice }
);
export interface KnowledgeStore {
  list(): KnowledgeEnvelope[];
  read(knowledgeId: string): KnowledgeEnvelope;
  write(command: KnowledgeWrite, actor: KnowledgeActor): KnowledgeEnvelope['receipts'][number];
}

/** Key ordering is UTF-16, matching the documented canonical-json-v1 contract. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Non-JSON value in knowledge command.');
}
