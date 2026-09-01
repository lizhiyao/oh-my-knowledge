import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Sha256Digest } from '../../../../evaluation-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../../evaluation-core/execution/index.js';

export interface ContentIdentityFile {
  readonly facetId: string;
  readonly path: string;
}

export interface CapturedIdentityFile extends ContentIdentityFile {
  readonly digest: Sha256Digest;
  readonly size: number;
}

const BUFFER_SIZE = 64 * 1024;

async function hashRegularFile(
  path: string,
  signal?: AbortSignal,
): Promise<{ readonly digest: Sha256Digest; readonly size: number }> {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('identity source is not a regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
    let position = 0;
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      position !== before.size
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) throw new Error('identity source changed while hashing');
    return {
      digest: `sha256:${hash.digest('hex')}`,
      size: position,
    };
  } finally {
    await handle.close();
  }
}

export async function captureIdentityFiles(
  files: readonly ContentIdentityFile[],
  adapterLabel: string,
): Promise<readonly CapturedIdentityFile[]> {
  const requested = [...structuredClone(files)].sort((left, right) => (
    left.facetId < right.facetId ? -1 : left.facetId > right.facetId ? 1 : 0
  ));
  if (new Set(requested.map((file) => file.facetId)).size !== requested.length) {
    throw new TypeError(`${adapterLabel} content identity facetIds must be unique.`);
  }
  return Object.freeze(await Promise.all(requested.map(async (file) => {
    const facetId = z.string().min(1).max(256).parse(file.facetId);
    if (!isAbsolute(file.path)) {
      throw new TypeError(`${adapterLabel} identity file "${facetId}" must be absolute.`);
    }
    let evidence: Awaited<ReturnType<typeof hashRegularFile>>;
    try {
      evidence = await hashRegularFile(file.path);
    } catch {
      throw new TypeError(`${adapterLabel} identity file "${facetId}" is unavailable.`);
    }
    return Object.freeze({
      facetId,
      path: file.path,
      digest: evidence.digest,
      size: evidence.size,
    });
  })));
}

export async function assertIdentityFilesUnchanged(
  files: readonly CapturedIdentityFile[],
  input: Readonly<{
    adapterLabel: string;
    cancellationCode: string;
    identityChangedCode: string;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  for (const file of files) {
    let evidence: Awaited<ReturnType<typeof hashRegularFile>>;
    try {
      evidence = await hashRegularFile(file.path, input.signal);
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
    if (evidence.size !== file.size || evidence.digest !== file.digest) {
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
