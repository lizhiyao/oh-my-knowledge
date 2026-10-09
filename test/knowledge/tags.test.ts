import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKnowledgeTags } from '../../src/observability/knowledge-extraction/adapters/knowledge-tags.js';
import { KnowledgeTagsSchema } from '../../src/knowledge/tags.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'omk-tags-')); roots.push(root); const folder = join(root, 'tags'); return { root, folder, store: new FileKnowledgeTags(folder, 'test') }; };
const actor = { actorKind: 'human' as const, actorId: 'tester' };

describe('knowledge topic tags', () => {
  it('normalizes user tags and rejects unsupported or excessive values', () => {
    expect(KnowledgeTagsSchema.parse([' 排障/证据判断 ', 'Taro', 'taro', 'Taro'])).toEqual(['排障/证据判断', 'Taro']);
    for (const value of [['#tag'], ['two words'], ['123'], ['a//b'], ['/a'], [''], Array.from({ length: 33 }, () => 'tag')]) expect(KnowledgeTagsSchema.safeParse(value).success).toBe(false);
  });
  it('preserves tag history, detects concurrent writes, clears tags and leaves no temporary files', () => {
    const { folder, store } = setup();
    expect(store.read('knowledge')).toEqual({ generation: 0, tags: [] });
    expect(store.write('knowledge', 0, ['排障'], actor)).toEqual({ generation: 1, tags: ['排障'] });
    const second = new FileKnowledgeTags(folder, 'test');
    expect(() => second.write('knowledge', 0, ['other'], actor)).toThrow('conflict');
    expect(second.write('knowledge', 1, ['排障'], actor).generation).toBe(1);
    expect(store.write('knowledge', 1, [], actor)).toEqual({ generation: 2, tags: [] });
    const files = readdirSync(folder); expect(files).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(folder, files[0]), 'utf8'));
    expect(saved.schemaVersion).toBe('omk-knowledge-tags/v1');
    expect(saved.revisions.map((entry: { tags: string[] }) => entry.tags)).toEqual([['排障'], []]);
    expect(saved.revisions[0].updatedBy).toEqual(actor);
  });
  it('rejects corrupt identities and symlink redirects without writing through them', () => {
    const { root, folder, store } = setup();
    store.write('knowledge', 0, ['tag'], actor);
    const path = join(folder, readdirSync(folder)[0]);
    const saved = JSON.parse(readFileSync(path, 'utf8')); saved.knowledgeId = 'other'; writeFileSync(path, JSON.stringify(saved));
    expect(() => store.read('knowledge')).toThrow('identity');
    rmSync(path); const target = join(root, 'target.json'); writeFileSync(target, JSON.stringify(saved)); symlinkSync(target, path);
    expect(() => store.write('knowledge', 1, [], actor)).toThrow('Invalid tag file');
    const external = join(root, 'external'); mkdirSync(external); const redirect = join(root, 'redirect'); symlinkSync(external, redirect);
    expect(() => new FileKnowledgeTags(redirect, 'test').write('new', 0, ['tag'], actor)).toThrow('Invalid tag directory');
    expect(readdirSync(external)).toEqual([]);
  });
});
