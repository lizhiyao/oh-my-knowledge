import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
