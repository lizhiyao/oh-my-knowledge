import { mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectIdentityFilesInDirectory } from '../../../../../src/eval-workflows/hosts/adapters/shared/content-identity.js';
import { contentSha256 } from '../../../../../src/shared/content-hash.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omk-content-identity-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const digestOf = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('共享内容身份', () => {
  it('contentSha256 对字符串与字节给出同一个带前缀摘要', () => {
    expect(contentSha256('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(contentSha256(new TextEncoder().encode('abc'))).toBe(contentSha256('abc'));
    expect(contentSha256('')).toBe(`sha256:${digestOf('')}`);
  });

  it('递归收集常规文件，facetId 由相对路径摘要派生，输出顺序按名字规范化而与写入顺序无关', async () => {
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'b.txt'), 'b');
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'nested', 'c.txt'), 'c');

    const files = await collectIdentityFilesInDirectory({
      root,
      facetNamespace: 'claude-sdk',
      label: 'Claude SDK runtime package',
    });

    expect(files.map((file) => file.path)).toEqual([
      join(root, 'a.txt'),
      join(root, 'b.txt'),
      join(root, 'nested', 'c.txt'),
    ]);
    expect(files.map((file) => file.facetId)).toEqual([
      `claude-sdk.file.${digestOf('a.txt')}`,
      `claude-sdk.file.${digestOf('b.txt')}`,
      `claude-sdk.file.${digestOf('nested/c.txt')}`,
    ]);
  });

  it('只跳过根目录下的 node_modules，嵌套目录里的同名目录仍算内容', async () => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, 'vendor', 'node_modules'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'skipped');
    await writeFile(join(root, 'vendor', 'node_modules', 'kept.js'), 'kept');

    const files = await collectIdentityFilesInDirectory({ root, facetNamespace: 'codex-sdk', label: 'Codex SDK bundled native runtime' });

    expect(files.map((file) => file.facetId)).toEqual([`codex-sdk.file.${digestOf('vendor/node_modules/kept.js')}`]);
  });

  it('目录读不到或含非常规条目时按 label 抛错，不静默少算身份', async () => {
    await expect(collectIdentityFilesInDirectory({
      root: join(root, 'missing'),
      facetNamespace: 'claude-native',
      label: 'Claude SDK runtime package',
    })).rejects.toThrow('Claude SDK runtime package is unavailable.');

    await symlink(join(root, 'target'), join(root, 'link'));
    await expect(collectIdentityFilesInDirectory({
      root,
      facetNamespace: 'claude-native',
      label: 'Claude SDK runtime package',
    })).rejects.toThrow('Claude SDK runtime package contains an unsupported entry.');
  });
});
