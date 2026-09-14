import { z } from 'zod';

export const EvidenceWindowSchema = z.strictObject({
  snapshotId: z.string().uuid(),
  sourceKind: z.literal('codex'),
  sourcePath: z.string().min(1),
  sourceVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  projectionVersion: z.literal('knowledge-window-v1'),
  capturedAt: z.iso.datetime({ offset: true }),
  startRecord: z.number().int().nonnegative(),
  endRecord: z.number().int().nonnegative(),
  origin: z.strictObject({ threadId: z.string().min(1), turnId: z.string().min(1).optional(), title: z.string(), cwd: z.string().optional() }).optional(),
  limitations: z.array(z.string()),
  records: z.array(z.strictObject({
    recordIndex: z.number().int().nonnegative(), raw: z.string(),
  })).min(1).max(100_000),
  excerpts: z.array(z.strictObject({
    evidenceRef: z.string().min(1), recordIndex: z.number().int().nonnegative(),
    eventKind: z.string().min(1), role: z.string().optional(), timestamp: z.string().optional(),
    text: z.string(),
  })).max(100_000),
});
export type EvidenceWindow = z.infer<typeof EvidenceWindowSchema>;
export type SourceSelection = { path: string; startRecord?: number; endRecord?: number; records?: EvidenceWindow['records']; origin?: EvidenceWindow['origin'] };
export type SourceResolution =
  | { status: 'available'; window: EvidenceWindow }
  | { status: 'unavailable'; reason: 'missing' | 'deleted' | 'invalid_source' | 'version_mismatch'; detail: string };
export interface EvidenceStore {
  capture(selection: SourceSelection, signal?: AbortSignal): EvidenceWindow;
  read(snapshotId: string, expectedVersion?: string): SourceResolution;
  delete(snapshotId: string): void;
}
