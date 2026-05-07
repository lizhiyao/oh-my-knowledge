/**
 * Executor result cache.
 *
 * Caches successful executor results to disk to avoid redundant API calls.
 * Cache key v4 = sha256(model + system + prompt + cwd + allowedSkills + executor + runtime).
 * Loaded into memory on init, flushed to disk on save().
 *
 * Prefix bumps intentionally invalidate old entries when construct-validity
 * dimensions enter the key:
 * - v2: allowedSkills / strict isolation
 * - v3: executor name
 * - v4: executor runtime fingerprint
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
  executor?: string,
  runtimeFingerprint?: string,
  /** Sample.mocks 序列化进 key:不同 mocks 配置必须独立 cache(否则改 mock 后老结果回来)。
   *  传 undefined / [] 时为空串,跟"无 mock 跑"等价。 */
  mocks?: unknown,
  /** Sample.mocksStrict 也进 key:strict on/off 行为不同,不能共享 cache。 */
  mocksStrict?: boolean,
): string {
  // allowedSkills 序列化:undefined → "" / [] → "[]" / [...] → 排序后 JSON。
  // 排序保证 ["a","b"] 和 ["b","a"] 命中同一缓存(语义等价)。
  const isoStr = allowedSkills === undefined
    ? ''
    : JSON.stringify([...allowedSkills].sort());
  // mocks 序列化:Array → JSON.stringify(顺序敏感,因为 return_seq 顺序有意义)。
  // 不做排序,因为 mocks 是有顺序的(命中规则按数组顺序匹配)。
  const mockStr = mocks === undefined
    ? ''
    : JSON.stringify(mocks);
  const strictStr = mocksStrict ? '1' : '';
  // executor + runtime 进 cache key:同 model 名走不同 executor 或同 executor
  // 换 binary/SDK 版本时输出可能不同,旧 cache 不可复用。
  const hash = createHash('sha256')
    .update(`${model || ''}\n${system || ''}\n${prompt || ''}\n${cwd || ''}\n${isoStr}\n${executor || ''}\n${runtimeFingerprint || ''}\n${mockStr}\n${strictStr}`)
    .digest('hex')
    .slice(0, 16);
  return `v4:${hash}`;
}
