import { z } from 'zod';
import type { ExtractionRun } from './runs.js';

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const namespace = z.enum(['current', 'legacy']);
export const ExtractionRunSealRequestSchema = z.strictObject({
  runId: z.string().uuid(), storageNamespace: namespace, operationId: z.string().uuid(),
  actor: z.strictObject({ actorKind: z.literal('human'), actorId: z.string().min(1).max(256).refine(value => value.trim().length > 0) }),
  reason: z.string().min(1).max(4096).refine(value => value.trim().length > 0), expectedManifestDigest: sha, expectedInventoryDigest: sha,
  offlineDeclared: z.boolean(),
});
export type ExtractionRunSealRequest = z.infer<typeof ExtractionRunSealRequestSchema>;
export const ExtractionRunSealFileSchema = z.strictObject({
  name: z.string().refine(value => value === 'manifest.json' || value.startsWith('outcomes/') && value.endsWith('.json') && z.string().uuid().safeParse(value.slice(9, -5)).success),
  bytes: z.number().int().nonnegative().max(512 * 1024 * 1024), digest: sha,
});
export const ExtractionRunSealIntentSchema = z.strictObject({
  storeKind: z.literal('knowledge-extraction-seal-intent'), schemaVersion: z.literal(1),
  request: ExtractionRunSealRequestSchema, recordedAt: z.iso.datetime({ offset: true }),
  evidenceScope: z.enum(['current-old-wire', 'opaque-unsupported-schema']),
  disposition: z.literal('human_sealed'), executionStatus: z.literal('unknown'),
  files: z.array(ExtractionRunSealFileSchema).min(1).max(65),
}).superRefine((intent, context) => {
  const names = intent.files.map(file => file.name), first = intent.files[0];
  if (!first || names[0] !== 'manifest.json' || first.bytes < 1 || first.bytes > 16 * 1024 * 1024
    || JSON.stringify(names.slice(1)) !== JSON.stringify([...names.slice(1)].sort()) || new Set(names).size !== names.length
    || first.digest !== intent.request.expectedManifestDigest) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Invalid seal inventory identity.' });
  }
  if (intent.evidenceScope === 'opaque-unsupported-schema' && !intent.request.offlineDeclared) {
    context.addIssue({ code: 'custom', path: ['request', 'offlineDeclared'], message: 'Opaque sealing requires an explicit offline declaration.' });
  }
});
export type ExtractionRunSealIntent = z.infer<typeof ExtractionRunSealIntentSchema>;
export const ExtractionRunSealMarkerSchema = z.strictObject({
  storeKind: z.literal('knowledge-extraction-seal-marker'), schemaVersion: z.literal(1),
  runId: z.string().uuid(), storageNamespace: namespace, operationId: z.string().uuid(), intentDigest: sha,
});
export interface ExtractionRunSealSummary extends ExtractionRunSealIntent {
  state: 'pending' | 'sealed';
  /** A listing is not a new durability or raw-archive integrity acknowledgement. */
  evidenceIntegrity: 'not_checked';
  originalRun?: ExtractionRun;
}
export interface ExtractionRunSealPreview {
  state: 'unsealed'; runId: string; storageNamespace: 'current' | 'legacy';
  evidenceScope: ExtractionRunSealIntent['evidenceScope'];
  expectedManifestDigest: string; expectedInventoryDigest: string;
  files: ExtractionRunSealIntent['files']; offlineDeclarationRequired: boolean;
  executionStatus: 'unknown';
}
export class ExtractionRunSealError extends Error {
  constructor(readonly sealCode: 'run_seal_conflict' | 'run_seal_ineligible' | 'run_seal_pending' | 'run_sealed') {
    super(sealCode); this.name = 'ExtractionRunSealError';
  }
}
