import type { z } from 'zod';
import type { TraceSourceMetadataSchema } from './trace-metadata-schema.js';
export type { TraceSourceKind } from '../../executors/contracts/trace-source.js';

export interface TraceIngestionSummary {
  fileCount: number;
  sourceRecordCount: number;
  parsedRecordCount: number;
  malformedRecordCount: number;
  ignoredValueCount: number;
  unknownEventCount: number;
  filteredSessionCount: number;
}

export type TraceSourceMetadata = z.infer<typeof TraceSourceMetadataSchema>;
