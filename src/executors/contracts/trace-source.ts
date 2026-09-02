/** Stable source identity shared by execution evidence and Trace IR. */
export type TraceSourceKind =
  | 'claude'
  | 'codex'
  | 'dsh'
  | 'openclaw'
  | 'markdown_log'
  | 'unknown';
