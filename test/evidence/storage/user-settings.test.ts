import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { UserSettingsStore } from '../../../src/evidence/storage/user-settings.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'omk-settings-')); roots.push(root); return new UserSettingsStore(root); };
it('reads defaults without writing, persists atomically, and detects stale saves', () => {
  const store = setup();
  expect(store.resolve({}, {})).toEqual({ workspace: join(store.root, 'knowledge'), executor: 'codex', model: '', language: 'zh' });
  expect(existsSync(store.path)).toBe(false);
  const input = { schemaVersion: 1, language: 'en', knowledge: { workspace: join(store.root, 'chosen'), executor: 'codex', model: 'saved-model' } };
  const saved = store.save(input, 'missing');
  expect(new UserSettingsStore(store.root).read()).toEqual(saved);
  expect(() => store.save(input, 'missing')).toThrow('conflict');
  expect(store.resolve({ model: 'explicit', language: 'zh' }, { OMK_MODEL: 'environment' })).toMatchObject({ model: 'explicit', language: 'zh' });
  expect(store.resolve({}, { OMK_MODEL: 'environment' })).toMatchObject({ model: 'environment', language: 'en' });
  expect(store.resolve({}, {})).toMatchObject({ model: 'saved-model' });
  expect(store.resolve({ executor: 'anthropic-api' }, {}).model).toBe('');
});
it('rejects secrets, relative paths, unknown schema versions and corrupt files without overwriting', () => {
  const store = setup();
  for (const input of [{ schemaVersion: 2 }, { schemaVersion: 1, apiKey: 'secret' }, { schemaVersion: 1, knowledge: { workspace: './relative' } }]) {
    expect(() => store.save(input, 'missing')).toThrow();
  }
  expect(existsSync(store.path)).toBe(false);
  writeFileSync(store.path, 'invalid');
  expect(() => store.read()).toThrow();
  expect(() => store.save({ schemaVersion: 1 }, 'missing')).toThrow();
});
