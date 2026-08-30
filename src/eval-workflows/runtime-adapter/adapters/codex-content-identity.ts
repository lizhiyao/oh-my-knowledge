import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Sha256Digest } from '../../../evaluation-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../evaluation-core/execution/index.js';

export interface CodexContentIdentityFile {
  readonly facetId: string;
  readonly path: string;
}

export interface CapturedCodexIdentityFile extends CodexContentIdentityFile {
  readonly digest: Sha256Digest;
  readonly size: number;
}

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function captureCodexIdentityFiles(
  files: readonly CodexContentIdentityFile[],
  adapterLabel: string,
): Promise<readonly CapturedCodexIdentityFile[]> {
  const requested = [...structuredClone(files)].sort((left, right) => (
    left.facetId < right.facetId ? -1 : left.facetId > right.facetId ? 1 : 0
  ));
  if (new Set(requested.map((file) => file.facetId)).size !== requested.length) {
    throw new TypeError(`${adapterLabel} content identity facetIds must be unique.`);
  }
  return Object.freeze(await Promise.all(requested.map(async (file) => {
    if (!isAbsolute(file.path)) {
      throw new TypeError(`${adapterLabel} identity file "${file.facetId}" must be absolute.`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file.path);
    } catch {
      throw new TypeError(`${adapterLabel} identity file "${file.facetId}" is unavailable.`);
    }
    return Object.freeze({
      facetId: z.string().min(1).max(256).parse(file.facetId),
      path: file.path,
      digest: sha256Bytes(bytes),
      size: bytes.byteLength,
    });
  })));
}

export async function assertCodexIdentityFilesUnchanged(
  files: readonly CapturedCodexIdentityFile[],
  input: Readonly<{
    adapterLabel: string;
    cancellationCode: string;
    identityChangedCode: string;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file.path, input.signal === undefined ? undefined : {
        signal: input.signal,
      });
    } catch {
      if (input.signal?.aborted) {
        throw new ExecutionPortFailure({
          code: input.cancellationCode,
          stage: 'execution',
          message: `${input.adapterLabel} execution was cancelled.`,
        });
      }
      if (input.signal === undefined) {
        throw new TypeError(`${input.adapterLabel} implementation identity could not be reverified.`);
      }
      throw new ExecutionPortFailure({
        code: input.identityChangedCode,
        stage: 'infrastructure',
        message: `${input.adapterLabel} implementation identity could not be reverified.`,
      });
    }
    if (bytes.byteLength !== file.size || sha256Bytes(bytes) !== file.digest) {
      if (input.signal === undefined) {
        throw new TypeError(`${input.adapterLabel} implementation changed during identity resolution.`);
      }
      throw new ExecutionPortFailure({
        code: input.identityChangedCode,
        stage: 'infrastructure',
        message: `${input.adapterLabel} implementation changed after adapter assembly.`,
      });
    }
  }
}
