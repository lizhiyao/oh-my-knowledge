import { z } from 'zod';
import { Sha256DigestSchema } from '../../../eval-core/contracts/index.js';

export const LocalTaskPathSchema = z.string().min(1).max(1024).refine((path) => (
  !path.includes('\\') && !path.includes(':') && !/[\x00-\x1f]/.test(path)
  && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'
    && !/^(?:\.git|\.ssh|\.aws|\.azure|\.config|\.codex|\.claude|\.env(?:\..*)?|.*\.(?:pem|key)|credentials(?:\..*)?|auth\.json)$/i.test(part))
), 'Expected a relative non-sensitive file path without traversal.');

export const TaskFileSchema = z.strictObject({
  path: LocalTaskPathSchema,
  contentBase64: z.string(),
  digest: Sha256DigestSchema,
  executable: z.boolean(),
});
export type TaskFile = z.infer<typeof TaskFileSchema>;

export const LocalTaskOutputSchema = z.strictObject({
  schemaVersion: z.literal('omk.local-task-output/v1'),
  response: z.string(),
  snapshotDigest: Sha256DigestSchema,
  files: z.array(TaskFileSchema.extend({ change: z.enum(['unchanged', 'modified', 'added']) })),
  missing: z.array(LocalTaskPathSchema),
  collectionErrors: z.array(z.strictObject({ path: LocalTaskPathSchema, code: z.string() })),
  source: z.strictObject({ sampleId: z.string(), variantId: z.string(), trialIndex: z.number().int(), attemptNumber: z.number().int() }),
});
export type LocalTaskOutput = z.infer<typeof LocalTaskOutputSchema>;

export const LocalTaskAcceptanceSchema = z.strictObject({
  schemaVersion: z.literal('omk.local-task-acceptance/v1'),
  passed: z.boolean(),
  checks: z.array(z.strictObject({ checkId: z.string().min(1), passed: z.boolean(), detail: z.string().max(4000) })).min(1),
}).refine((value) => value.passed === value.checks.every((check) => check.passed), 'Overall result must match checks.')
  .refine((value) => new Set(value.checks.map((check) => check.checkId)).size === value.checks.length, 'Duplicate check IDs.');
