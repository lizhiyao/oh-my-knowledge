import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { loadInboxPage } from '../../../src/studio/http/inbox-page.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('studio inbox page bridge', () => {
  it('returns the shared projection for an empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-page-'));
    dirs.push(dir);
    const page = loadInboxPage(dir, undefined);
    assert.equal(page.pageKind, 'inbox');
    assert.deepEqual(page.model.items, []);
    assert.deepEqual(page.model.allItems, []);
    assert.equal(page.model.skillCount, 0);
    assert.equal(page.model.reportCount, 0);
  });

  it('passes the skill filter through to the projection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-page-skill-'));
    dirs.push(dir);
    const page = loadInboxPage(dir, 'audit');
    assert.equal(page.model.activeSkill, 'audit');
  });
});
