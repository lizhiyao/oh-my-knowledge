/**
 * Executor result cache.
 *
 * Caches successful executor results to disk to avoid redundant API calls.
 * Cache key = sha256(model + system + prompt).
 * Loaded into memory on init, flushed to disk on save().
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const CACHE_FILE = 'executor-cache.json';

export function createCache(cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const filePath = join(cacheDir, CACHE_FILE);

  let store = {};
  if (existsSync(filePath)) {
    try {
      store = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      store = {};
    }
  }

  let dirty = false;

  return {
    get(key) {
      return store[key] || null;
    },

    set(key, value) {
      store[key] = value;
      dirty = true;
    },

    save() {
      if (!dirty) return;
      writeFileSync(filePath, JSON.stringify(store, null, 2));
      dirty = false;
    },

    size() {
      return Object.keys(store).length;
    },
  };
}

export function cacheKey(model, system, prompt) {
  return createHash('sha256')
    .update(`${model || ''}\n${system || ''}\n${prompt || ''}`)
    .digest('hex')
    .slice(0, 16);
}
