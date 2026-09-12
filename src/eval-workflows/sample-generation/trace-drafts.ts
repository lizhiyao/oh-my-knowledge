import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { queryObservationInbox } from '../../observability/inbox/index.js';
import { observationDraftsDir } from '../../observability/inbox/paths.js';
import { createJsonFileAtomic } from '../../shared/atomic-json.js';
import { createWorkflowSampleSetDocument } from '../inputs/schemas/sample-set.js';
import type { generateSamplesFromTraces } from './generator.js';

type TraceGenerator = typeof generateSamplesFromTraces;
type TraceOptions = Omit<Parameters<TraceGenerator>[0], 'items'>;

export class TraceDraftPreparationError extends Error {
  constructor(readonly reason: 'missing-inbox' | 'existing-draft', readonly path: string) {
    super(`Trace draft preparation failed (${reason}): ${path}`);
    this.name = 'TraceDraftPreparationError';
  }
}

/** Signals create reviewable drafts, never an automatically admitted evaluation set. */
export async function generateTraceDrafts(input: {
  readonly observationsDir: string;
  readonly skill?: string;
  readonly options: TraceOptions;
  readonly onGenerating?: (signalCount: number) => void;
}, generate?: TraceGenerator) {
  const { observationsDir, skill, options } = input;
  options.signal?.throwIfAborted();
  if (!existsSync(observationsDir)) throw new TraceDraftPreparationError('missing-inbox', observationsDir);
  const items = queryObservationInbox(observationsDir)
    .filter((item) => item.severity !== 'noise' && (!skill || item.skillName === skill));
  if (items.length === 0) return { draftStatus: 'no-signals' as const };
  const outputPath = join(observationDraftsDir(observationsDir), 'sample-drafts.json');
  if (existsSync(outputPath)) throw new TraceDraftPreparationError('existing-draft', outputPath);
  input.onGenerating?.(items.length);
  const generator = generate ?? (await import('./generator.js')).generateSamplesFromTraces;
  const { samples, costUSD } = await generator({ ...options, items });
  options.signal?.throwIfAborted();
  if (samples.length === 0) return { draftStatus: 'empty' as const, costUSD };
  mkdirSync(dirname(outputPath), { recursive: true });
  createJsonFileAtomic(outputPath, createWorkflowSampleSetDocument(samples));
  return { draftStatus: 'generated' as const, outputPath, count: samples.length, costUSD };
}
