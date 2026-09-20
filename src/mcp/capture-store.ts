import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  captureExplicitObservation,
  ExplicitObservationCaptureConflictError,
  type ExplicitObservationCaptureInput,
  type ExplicitObservationCaptureOptions,
  type ExplicitObservationCaptureResult,
} from '../observability/inbox/explicit-capture.js';
import { projectObservationsDir } from '../observability/inbox/paths.js';
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
  /** 未显式指定时按调用时的当前项目解析，不在构造时冻结 cwd。 */
  protected readonly observationsDir: string | undefined;
  protected readonly now?: () => Date;
  private readonly partition: 'principal' | 'shared';

  constructor(options: FileObservationCaptureStoreOptions = {}) {
    this.observationsDir = options.observationsDir;
    this.now = options.now;
    this.partition = options.partition ?? 'principal';
  }

  async create(
    rawPrincipal: ObservationPrincipal,
    capture: ExplicitObservationCaptureInput,
  ): Promise<ExplicitObservationCaptureResult> {
    const principal = validateObservationPrincipal(rawPrincipal);
    const observationsDir = this.resolveObservationsDir(principal);
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

  protected resolveObservationsDir(principal: ObservationPrincipal): string {
    const root = this.observationsDir ?? projectObservationsDir();
    return this.partition === 'shared'
      ? root
      : join(
        root,
        'tenants',
        hashPartition('tenant', principal.tenantId),
        'principals',
        hashPartition('principal', principal.principalId),
      );
  }
}

function hashPartition(label: 'tenant' | 'principal', value: string): string {
  return createHash('sha256')
    .update(`${label}\u0000${value}`)
    .digest('hex')
    .slice(0, 24);
}
