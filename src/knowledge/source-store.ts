import type { SourceProjection, SourceResolution, SourceSnapshot } from './sources.js';

export interface SourceCaptureOptions {
  /** A new reference after explicit deletion; the deleted reference remains a tombstone. */
  afterDeletion?: 'new_snapshot';
  signal?: AbortSignal;
}
export interface SourceCaptureResult { snapshot: SourceSnapshot; reused: boolean }
export interface SourceBatchCaptureResult { sources: SourceCaptureResult[]; writtenBytes: number }
export type SourceStoreErrorCode = 'capacity_exceeded' | 'permission_denied' | 'corrupt' | 'unsupported'
  | 'version_mismatch' | 'missing' | 'deleted' | 'busy';

/** Captures already-read material. Selection, preview consent and upstream reads belong to the caller.
 * A busy write has not entered its operation; callers may retry the identical projection or deletion reference. */
export interface SourceStore {
  capture(projection: SourceProjection, options?: SourceCaptureOptions): SourceCaptureResult;
  /** Preflights the whole batch before publication. I/O interruption may commit a prefix; retry identical projections. */
  captureBatch(projections: readonly SourceProjection[], options?: SourceCaptureOptions): SourceBatchCaptureResult;
  read(snapshotId: string, expectedVersion?: string): SourceResolution;
  delete(snapshotId: string, expectedVersion?: string): void;
}
