import { compareStrings } from '../../../../eval-core/primitives/ordering.js';
import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type { Sha256Digest } from '../../../../eval-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../../eval-core/execution/index.js';

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
    compareStrings(left.facetId, right.facetId)
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

/**
 * 递归收集目录下的常规文件，facetId 由相对路径摘要派生；根目录下的 node_modules 整棵跳过。
 *
 * claude 与 codex 的 SDK 运行时曾经各存一份逐字相同的实现，只有报错文案里的宿主名不同，
 * 因此文案由 label 统一派生。
 */
export async function collectIdentityFilesInDirectory(input: {
  readonly root: string;
  readonly facetNamespace: string;
  readonly label: string;
  readonly current?: string;
}): Promise<readonly ContentIdentityFile[]> {
  const current = input.current ?? input.root;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    throw new TypeError(`${input.label} is unavailable.`);
  }
  const files: ContentIdentityFile[] = [];
  for (const entry of entries.sort((left, right) => (
    compareStrings(left.name, right.name)
  ))) {
    if (current === input.root && entry.name === 'node_modules' && entry.isDirectory()) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectIdentityFilesInDirectory({ ...input, current: path }));
    } else if (entry.isFile()) {
      const relativePath = relative(input.root, path).replaceAll('\\', '/');
      const pathDigest = createHash('sha256').update(relativePath).digest('hex');
      files.push({ facetId: `${input.facetNamespace}.file.${pathDigest}`, path });
    } else {
      throw new TypeError(`${input.label} contains an unsupported entry.`);
    }
  }
  return files;
}
