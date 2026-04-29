/**
 * Executor result cache.
 *
 * Caches successful executor results to disk to avoid redundant API calls.
 * Cache key v2 = "v2:" + sha256(model + system + prompt + cwd + allowedSkills).
 * Loaded into memory on init, flushed to disk on save().
 *
 * key prefix bump v1 → v2 invalidates pre-isolation cache entries
 * (otherwise a strict-baseline run could replay a non-isolated cached result
 * and silently keep the contamination).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ExecResult, ExecutorCache } from '../types/index.js';

const CACHE_FILE = 'executor-cache.json';

export function createCache(cacheDir: string): ExecutorCache {
  mkdirSync(cacheDir, { recursive: true });
  const filePath = join(cacheDir, CACHE_FILE);

  let store: Record<string, ExecResult> = {};
  if (existsSync(filePath)) {
    try {
      store = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      store = {};
    }
  }

  let dirty = false;

  return {
    get(key: string): ExecResult | null {
      return store[key] || null;
    },

    set(key: string, value: ExecResult): void {
      const cacheable = { ...value };
      delete cacheable.turns;
      delete cacheable.toolCalls;
      store[key] = cacheable;
      dirty = true;
    },

    save(): void {
      if (!dirty) return;
      writeFileSync(filePath, JSON.stringify(store, null, 2));
      dirty = false;
    },

    size(): number {
      return Object.keys(store).length;
    },
  };
}

export function cacheKey(
  model: string,
  system: string,
  prompt: string,
  cwd?: string | null,
  allowedSkills?: string[],
): string {
  // allowedSkills 序列化:undefined → "" / [] → "[]" / [...] → 排序后 JSON。
  // 排序保证 ["a","b"] 和 ["b","a"] 命中同一缓存(语义等价)。
  const isoStr = allowedSkills === undefined
    ? ''
    : JSON.stringify([...allowedSkills].sort());
  const hash = createHash('sha256')
    .update(`${model || ''}\n${system || ''}\n${prompt || ''}\n${cwd || ''}\n${isoStr}`)
    .digest('hex')
    .slice(0, 16);
  return `v2:${hash}`;
}
