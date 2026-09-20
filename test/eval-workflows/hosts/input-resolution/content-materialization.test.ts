import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  materializeContentAddressedBytes,
  type MaterializationRejection,
} from '../../../../src/eval-workflows/hosts/input-resolution/content-materialization.js';

class Rejected extends Error {
  constructor(readonly rejection: MaterializationRejection) {
    super(`materialization rejected: ${rejection.reason}`);
  }
}

const reject = (rejection: MaterializationRejection): never => {
  throw new Rejected(rejection);
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omk-content-materialization-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const materialize = (bytes: Uint8Array, extension: '.json' | '.txt' | '.md' = '.md') =>
  materializeContentAddressedBytes({ root, bytes, extension, reject });

describe('内容寻址物化原语', () => {
  it('按内容摘要落盘到 content 子目录，文件权限 0600，同内容重复物化幂等', async () => {
    const bytes = new TextEncoder().encode('# skill\n');
    const path = await materialize(bytes);

    expect(path).toBe(join(root, 'content', `${sha256(bytes)}.md`));
    expect(await readFile(path, 'utf-8')).toBe('# skill\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'content'))).mode & 0o777).toBe(0o700);
    expect(await materialize(bytes)).toBe(path);
  });

  it('扩展名由调用方决定，摘要仍只按内容算', async () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    const path = await materialize(bytes, '.json');
    expect(path).toBe(join(root, 'content', `${sha256(bytes)}.json`));
  });

  it('同路径已有不同内容时拒绝，并且不覆盖既有文件', async () => {
    const bytes = new TextEncoder().encode('original');
    const path = await materialize(bytes);
    await writeFile(path, 'not the original any more');

    await expect(materialize(bytes)).rejects.toThrow('materialization rejected: digest-mismatch');
    expect(await readFile(path, 'utf-8')).toBe('not the original any more');
  });

  it('目标路径是符号链接时拒绝，不跟随写入', async () => {
    const bytes = new TextEncoder().encode('link target');
    const content = join(root, 'content');
    await rm(content, { recursive: true, force: true });
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'untouched');
    await mkdir(content, { recursive: true });
    await symlink(outside, join(content, `${sha256(bytes)}.md`));

    await expect(materialize(bytes)).rejects.toThrow('materialization rejected: path-not-plain');
    expect(await readFile(outside, 'utf-8')).toBe('untouched');
  });

  it('content 目录本身是符号链接时拒绝', async () => {
    const realDirectory = join(root, 'real-content');
    await mkdir(realDirectory, { recursive: true });
    await symlink(realDirectory, join(root, 'content'));

    await expect(materialize(new TextEncoder().encode('x')))
      .rejects.toThrow('materialization rejected: content-directory-not-plain');
  });

  it('不变量违规只报告一次：拒绝原因不会被外层兜底改写成 unsafe', async () => {
    const bytes = new TextEncoder().encode('once');
    const content = join(root, 'content');
    await mkdir(content, { recursive: true });
    await symlink(join(root, 'missing'), join(content, `${sha256(bytes)}.md`));

    const seen: MaterializationRejection[] = [];
    await expect(materializeContentAddressedBytes({
      root,
      bytes,
      extension: '.md',
      reject: (rejection) => {
        seen.push(rejection);
        throw new Rejected(rejection);
      },
    })).rejects.toThrow('materialization rejected: path-not-plain');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe('path-not-plain');
    expect(seen[0]?.path).toBe(join(content, `${sha256(bytes)}.md`));
  });
});
