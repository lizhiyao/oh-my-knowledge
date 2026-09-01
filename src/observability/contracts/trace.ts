/** Stable source identity shared by execution evidence and Trace IR. */
export type TraceSourceKind =
  | 'claude'
  | 'codex'
  | 'dsh'
  | 'openclaw'
  | 'markdown_log'
  | 'unknown';

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
