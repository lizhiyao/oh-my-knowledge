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

export interface TraceSourceMetadata {
  channel?: string;
  sender?: string;
  senderId?: string;
  provider?: string;
  model?: string;
  modelApi?: string;
  businessActions?: string[];
}
