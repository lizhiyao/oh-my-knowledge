import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EntityAnalysisDraftSchema } from '../entities/contracts.js';
import { validateEntityAnalysis, validateEntityMentionSelection } from '../entities/validation.js';
import { canonicalJson } from '../store.js';
import { EvidenceWindowSchema } from './evidence.js';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const uuid = z.string().uuid(), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const BoundKnowledgeSourceSchema = EvidenceWindowSchema.pick({ snapshotId: true, sourceVersion: true, excerpts: true, limitations: true });
export const BoundKnowledgeCatalogSchema = EntityAnalysisDraftSchema.extend({ analysisId: uuid, revisionId: uuid,
  snapshotId: uuid, sourceVersion: digest });
export const BoundKnowledgeBindingSchema = z.strictObject({ snapshotId: uuid, sourceVersion: digest, analysisId: uuid, revisionId: uuid,
  sourceProjectionDigest: digest, entityAnalysisDigest: digest });
export type BoundKnowledgeSource = z.infer<typeof BoundKnowledgeSourceSchema>;
/** Complete immutable revision projection. A usage policy never changes this projection. */
export type BoundKnowledgeCatalog = z.infer<typeof BoundKnowledgeCatalogSchema>;
export type BoundKnowledgeBinding = z.infer<typeof BoundKnowledgeBindingSchema>;

export function validUtf8(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (Buffer.from(current, 'utf8').toString('utf8') !== current) return false;
    } else if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) pending.push(key, child);
    }
  }
  return true;
}
export function projectBoundCatalog(sourceInput: BoundKnowledgeSource, catalogInput: BoundKnowledgeCatalog) {
  const source = BoundKnowledgeSourceSchema.parse({ snapshotId: sourceInput.snapshotId, sourceVersion: sourceInput.sourceVersion,
    excerpts: sourceInput.excerpts, limitations: sourceInput.limitations });
  const projection = { analysisId: catalogInput.analysisId, revisionId: catalogInput.revisionId,
    snapshotId: catalogInput.snapshotId, sourceVersion: catalogInput.sourceVersion,
    entities: catalogInput.entities, mentions: catalogInput.mentions, limitations: catalogInput.limitations };
  if (!validUtf8(source) || !validUtf8(projection)) throw new Error('Bound knowledge source/catalog is not valid UTF-8.');
  const catalog = BoundKnowledgeCatalogSchema.parse(projection);
  if (canonicalJson(catalog) !== canonicalJson(projection)) throw new Error('Catalog projection would require normalization.');
  if (source.snapshotId !== catalog.snapshotId || source.sourceVersion !== catalog.sourceVersion) throw new Error('Entity analysis source binding mismatch.');
  if (new Set(source.excerpts.map(value => value.evidenceRef)).size !== source.excerpts.length) throw new Error('Ambiguous evidence window.');
  const problems = [...validateEntityAnalysis(catalog), ...catalog.mentions.flatMap(mention => validateEntityMentionSelection(mention.selection, source.excerpts))];
  if (problems.length) throw new Error(`Invalid bound entity analysis: ${[...new Set(problems)].join(',')}`);
  const binding: BoundKnowledgeBinding = { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
    analysisId: catalog.analysisId, revisionId: catalog.revisionId,
    sourceProjectionDigest: hash(canonicalJson(source)), entityAnalysisDigest: hash(canonicalJson(catalog)) };
  return { source, catalog, binding };
}
