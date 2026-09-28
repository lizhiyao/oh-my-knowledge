import { z } from 'zod';
import { EvalSampleSetDocumentSchema } from '../schemas/sample-set.js';
import { LocalTaskPathSchema } from './local-task-evidence.js';
export * from './local-task-evidence.js';

const FilesSchema = z.array(LocalTaskPathSchema).min(1).max(256)
  .refine((paths) => new Set(paths).size === paths.length, 'Duplicate file paths.');

export const LocalTaskDefinitionSchema = z.strictObject({
  schemaVersion: z.literal('omk.local-task/v1'),
  taskId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  trust: z.literal('trusted-local'),
  samples: EvalSampleSetDocumentSchema,
  snapshot: z.strictObject({ root: z.string().min(1), files: FilesSchema }),
  artifacts: z.strictObject({ files: FilesSchema, maxBytes: z.number().int().positive().max(16 * 1024 * 1024) }),
  variants: z.strictObject({ control: z.string().min(1), treatment: z.string().min(1) }),
  execution: z.discriminatedUnion('runtimeKind', [
    z.strictObject({
      runtimeKind: z.literal('codex'), executable: z.string().min(1), model: z.string().min(1),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
      timeoutMs: z.number().int().positive(),
      identityFiles: z.array(z.strictObject({ facetId: z.string().min(1), path: z.string().min(1) })).default([]),
    }),
    z.strictObject({
      runtimeKind: z.literal('fixture'), script: z.string().min(1),
      timeoutMs: z.number().int().positive(),
    }),
  ]),
  acceptance: z.strictObject({
    root: z.string().min(1), files: FilesSchema, entrypoint: LocalTaskPathSchema,
    timeoutMs: z.number().int().positive(),
  }).refine((value) => value.files.includes(value.entrypoint), 'Entrypoint must be included in acceptance files.'),
  trials: z.number().int().positive().max(100).default(1),
  seed: z.string().min(1).default('local-task-v1'),
});

export type LocalTaskDefinition = z.infer<typeof LocalTaskDefinitionSchema>;
