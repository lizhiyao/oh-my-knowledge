import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationProject } from '../../src/observability/conversation/project.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function root() { const value = mkdtempSync(join(tmpdir(), 'omk-project-')); roots.push(value); return value; }

it('groups repository subdirectories and linked worktrees by their explicit common directory', () => {
  const base = root(); const repo = join(base, 'repo'); const worktree = join(base, 'checkout');
  mkdirSync(join(repo, '.git', 'worktrees', 'checkout'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'checkout')}\n`);
  writeFileSync(join(repo, '.git', 'worktrees', 'checkout', 'commondir'), '../..\n');
  expect(conversationProject(worktree)).toEqual(conversationProject(repo));
  expect(conversationProject(join(repo, 'src'))).toEqual(conversationProject(repo));
  expect(conversationProject(repo)?.name).toBe('repo');
});

it('does not merge similarly named, deleted, unassigned or broken nested repositories', () => {
  const base = root(); const a = join(base, 'a', 'repo'); const b = join(base, 'b', 'repo');
  mkdirSync(join(base, '.git')); mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  writeFileSync(join(a, '.git'), 'gitdir: missing'); writeFileSync(join(b, '.git'), 'invalid');
  expect(conversationProject(a)?.projectId).not.toBe(conversationProject(b)?.projectId);
  expect(conversationProject(a)?.projectId).not.toBe(conversationProject(base)?.projectId);
  expect(conversationProject(join(base, 'deleted'))?.projectId).not.toBe(conversationProject(base)?.projectId);
  expect(conversationProject()).toBeUndefined();
});

it('resolves symlinked working directories to the same project as their real path', () => {
  const base = root(); const repo = join(base, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const link = join(base, 'link');
  symlinkSync(repo, link, 'dir');
  expect(conversationProject(link)).toEqual(conversationProject(repo));
  expect(conversationProject(link)?.directory).toBe(conversationProject(repo)?.directory);
});

it('lets a nested repository keep its own identity instead of inheriting the parent', () => {
  const base = root(); const child = join(base, 'nested', 'child');
  mkdirSync(join(base, '.git'));
  mkdirSync(join(child, '.git'), { recursive: true });
  const parent = conversationProject(base);
  const nested = conversationProject(child);
  expect(nested?.projectId).not.toBe(parent?.projectId);
  expect(nested?.name).toBe('child');
  expect(nested?.directory).toBe(realpathSync(child));
});

it('treats an oversized .git file as opaque instead of parsing it as a gitdir pointer', () => {
  const base = root(); const child = join(base, 'child');
  mkdirSync(join(base, '.git'));
  mkdirSync(child, { recursive: true });
  // 超过 4096 字节的 .git 文件不可能是真实 gitdir 指针；解析它会误读被填充过的文件。
  writeFileSync(join(child, '.git'), `gitdir: ${'x'.repeat(5000)}\n`);
  const parent = conversationProject(base);
  const opaque = conversationProject(child);
  expect(opaque?.projectId).not.toBe(parent?.projectId);
  expect(opaque?.directory).toBe(realpathSync(child));
});
