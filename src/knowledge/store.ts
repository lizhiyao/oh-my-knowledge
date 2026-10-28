import { z } from 'zod';
import { KnowledgeActorSchema, KnowledgeRevisionSchema } from './contracts.js';
import type { KnowledgeActor } from './contracts.js';

const id = z.string().min(1).max(256);
export const MaintenanceSchema = z.strictObject({
  revisionId: id, choice: z.enum(['retain', 'discard']),
  actor: KnowledgeActorSchema, at: z.iso.datetime({ offset: true }), reason: z.string().min(1).max(4096),
});
export type MaintenanceChoice = z.infer<typeof MaintenanceSchema>;
export const KnowledgeEnvelopeSchema = z.strictObject({
  storeKind: z.literal('knowledge-item-history'), schemaVersion: z.literal(3),
  namespace: id, knowledgeId: id, generation: z.number().int().positive(), writeHeadRevisionId: id,
  revisions: z.array(KnowledgeRevisionSchema).min(1),
  maintenance: z.array(MaintenanceSchema),
  receipts: z.array(z.strictObject({ requestId: id, commandDigest: z.string(), committedGeneration: z.number().int().positive(), revisionId: id })).min(1),
});
export type KnowledgeEnvelope = z.infer<typeof KnowledgeEnvelopeSchema>;
const writeIdentity = {
  requestId: id, knowledgeId: id, expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
export const KnowledgeWriteSchema = z.discriminatedUnion('commandKind', [
  z.strictObject({ ...writeIdentity, commandKind: z.literal('append_revision'), expectedHeadRevisionId: id.nullable(), revision: KnowledgeRevisionSchema }),
  z.strictObject({ ...writeIdentity, commandKind: z.literal('record_maintenance'), maintenance: MaintenanceSchema }),
]);
export type KnowledgeWrite = z.infer<typeof KnowledgeWriteSchema>;
export interface KnowledgeStore {
  list(knowledgeIds?: ReadonlySet<string>): KnowledgeEnvelope[];
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
