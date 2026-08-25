import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  captureExplicitObservation,
  ExplicitObservationCaptureConflictError,
  type ExplicitObservationCaptureInput,
  type ExplicitObservationCaptureOptions,
  type ExplicitObservationCaptureResult,
} from '../observability/explicit-capture.js';
import { DEFAULT_OBSERVATIONS_DIR } from '../observability/observation-paths.js';
import {
  validateObservationPrincipal,
  type ObservationPrincipal,
} from './principal.js';

export interface ObservationCaptureStore {
  create(
    principal: ObservationPrincipal,
    capture: ExplicitObservationCaptureInput,
  ): Promise<ExplicitObservationCaptureResult>;
}

export type ObservationCaptureStoreErrorCode = 'capture_conflict' | 'capture_store_failed';

export class ObservationCaptureStoreError extends Error {
  constructor(
    readonly code: ObservationCaptureStoreErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'ObservationCaptureStoreError';
  }
}

export interface FileObservationCaptureStoreOptions extends ExplicitObservationCaptureOptions {
  /**
   * `principal` hashes tenant and principal IDs into separate directories.
   * `shared` preserves the v1 single-user stdio layout.
   */
  partition?: 'principal' | 'shared';
}

export class FileObservationCaptureStore implements ObservationCaptureStore {
  private readonly observationsDir: string;
  private readonly now?: () => Date;
  private readonly partition: 'principal' | 'shared';

  constructor(options: FileObservationCaptureStoreOptions = {}) {
    this.observationsDir = options.observationsDir ?? DEFAULT_OBSERVATIONS_DIR;
    this.now = options.now;
    this.partition = options.partition ?? 'principal';
  }

  async create(
    rawPrincipal: ObservationPrincipal,
    capture: ExplicitObservationCaptureInput,
  ): Promise<ExplicitObservationCaptureResult> {
    const principal = validateObservationPrincipal(rawPrincipal);
    const observationsDir = this.partition === 'shared'
      ? this.observationsDir
      : join(
        this.observationsDir,
        'tenants',
        hashPartition('tenant', principal.tenantId),
        'principals',
        hashPartition('principal', principal.principalId),
      );
    try {
      return captureExplicitObservation(capture, {
        observationsDir,
        now: this.now,
      });
    } catch (error) {
      const conflict = error instanceof ExplicitObservationCaptureConflictError;
      throw new ObservationCaptureStoreError(
        conflict ? 'capture_conflict' : 'capture_store_failed',
        conflict ? error.message : 'Observation capture 写入失败。',
        { cause: error },
      );
    }
  }
}

function hashPartition(label: 'tenant' | 'principal', value: string): string {
  return createHash('sha256')
    .update(`${label}\u0000${value}`)
    .digest('hex')
    .slice(0, 24);
}
