import type { TraceSourceKind } from '../../shared/contracts/trace-source.js';

export type { TraceSourceKind } from '../../shared/contracts/trace-source.js';

export interface TraceIngestionSummary {
  fileCount: number;
  sourceRecordCount: number;
  parsedRecordCount: number;
  malformedRecordCount: number;
  ignoredValueCount: number;
  unknownEventCount: number;
  filteredSessionCount: number;
}

export interface TraceSourceMetadata {
  channel?: string;
  sender?: string;
  senderId?: string;
  provider?: string;
  model?: string;
  modelApi?: string;
  businessActions?: string[];
}

/** @deprecated Prefer TraceSourceKind for new source-neutral APIs. */
export type ObservationSourceKind = TraceSourceKind;
