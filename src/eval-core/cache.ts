/**
 * Executor result cache.
 *
 * Caches successful executor results to disk to avoid redundant API calls.
 * Cache key v9 = sha256(model + system + prompt + cwd + allowedSkills + executor +
 *                       runtime + mocks + mocksStrict + effort + artifactContentHash +
 *                       sampleExecutionDependencyHash).
 * Loaded into memory on init, flushed to disk on save().
 *
 * Prefix bumps intentionally invalidate old entries when construct-validity
 * dimensions enter the key:
 * - v2: allowedSkills / strict isolation
 * - v3: executor name
 * - v4: executor runtime fingerprint
 * - v5: effort(同 model/prompt 不同 effort 的输出本就该独立 cache,旧 cache 命中会让
 *       报告 meta 标的 effort 跟实际跑的 effort 不一致 — 测量可比性污染);
 *       同时 cache.set 不再砍 turns / toolCalls — 工具类断言 + diagnostic 要看 trace,
 *       砍掉的话 cached rerun 会让工具断言为空、diagnostic 没真实证据,跟 cold run 不一致
 * - v6: artifact 内容指纹(contentHash)。`system` 只含 SKILL.md 正文,但本地 dir-skill 的
 *       references/ 资产是真实运行时输入(cwd=skillRoot,agent 可读),改资产只动 contentHash、
 *       不动 system → 旧 key 会命中旧输出、贴到新 artifactHashes 上,形成静默测量污染。把
 *       contentHash 纳入 key,资产变即重跑。git skill 的 contentHash 只随 SKILL.md 变(其资产不
 *       暴露给 executor、本就不该触发重跑),口径自洽
 * - v7: executor 返回值进入统一契约校验，且所有未知成本路径显式记录 provenance。
 *       旧缓存缺少这些语义，不能在新报告中继续复用。
 * - v8: 所有 executor 的工具身份在统一边界归一化。旧缓存里的 provider-native
 *       工具名不能继续参与 source-neutral 工具断言与分布统计。
 * - v9: sample mock 的 `return_file` 内容指纹进入 key。只哈声明路径会在 fixture
 *       内容变化后错误复用旧执行结果。
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ExecResult, ExecutorCache } from '../types/index.js';
import {
  executorResultValidationError,
  normalizeExecResultToolIdentities,
  parseExecResult,
} from '../shared/executor-result.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';
import { withFileLock } from '../shared/file-lock.js';

const CACHE_FILE = 'executor-cache.json';
/** v5 保留 turns / toolCalls 后单 entry 可达 5–50 KB,长期使用会无界膨胀。
 *  Map iteration 是插入序,set() 时若 key 已存在先 delete 再 set 把它移到末尾 → 实现 LRU。
 *  超过 cap 时淘汰最旧条目(Map iterator 第一个)。
 *  默认 2000 条按平均 20 KB 算 ~40 MB,撑住"大半年评测史"的同时保证不爆盘。
 *  用户用 `OMK_CACHE_MAX_ENTRIES` 调:0 / 负数 → 不限制(回到老行为)。 */
const DEFAULT_MAX_ENTRIES = 2000;
function resolveCacheCap(): number {
  const raw = process.env.OMK_CACHE_MAX_ENTRIES;
  if (raw == null || raw === '') return DEFAULT_MAX_ENTRIES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ENTRIES;
  if (n <= 0) return Infinity;
  return Math.floor(n);
}

export function createCache(cacheDir: string): ExecutorCache {
  mkdirSync(cacheDir, { recursive: true });
  const filePath = join(cacheDir, CACHE_FILE);
  const cap = resolveCacheCap();
  const store = readCacheStore(filePath, cap);
  const pendingWrites = new Map<string, ExecResult>();
  const touchedKeys = new Set<string>();

  let dirty = false;

  return {
    get(key: string): ExecResult | null {
      const v = store.get(key);
      if (v == null) return null;
      // LRU touch:命中时移到末尾(最新)。这样 evict 时永远从最旧端拿。
      store.delete(key);
      store.set(key, v);
      touchedKeys.add(key);
      dirty = true;
      return v;
    },

    set(key: string, value: ExecResult): void {
      // 保留完整 ExecResult(含 turns / toolCalls):工具类 assertion (tool_called /
      // tool_input_contains / tools_called)和 diagnostic 要看 trace,砍掉的话 cached
      // rerun 进 grade() 时工具断言为空、diagnostic 没真实证据,跟 cold run 不一致。
      const validationError = executorResultValidationError(value);
      if (validationError) throw new Error(`invalid executor cache entry: ${validationError}`);
      const normalized = normalizeExecResultToolIdentities(value);
      if (store.has(key)) store.delete(key);
      store.set(key, normalized);
      pendingWrites.delete(key);
      pendingWrites.set(key, normalized);
      touchedKeys.delete(key);
      evictUntilWithinCap(store, cap);
      for (const pendingKey of pendingWrites.keys()) {
        if (!store.has(pendingKey)) pendingWrites.delete(pendingKey);
      }
      dirty = true;
    },

    save(): void {
      if (!dirty) return;
      withFileLock(`${filePath}.lock`, () => {
        // Another eval process may have saved after this cache instance loaded.
        // Merge only local writes and LRU touches into the latest disk state;
        // replacing it with the whole stale in-memory snapshot loses entries.
        const merged = readCacheStore(filePath, cap);
        for (const key of touchedKeys) {
          const value = merged.get(key);
          if (!value) continue;
          merged.delete(key);
          merged.set(key, value);
        }
        for (const [key, value] of pendingWrites) {
          if (merged.has(key)) merged.delete(key);
          merged.set(key, value);
        }
        evictUntilWithinCap(merged, cap);
        writeCacheStore(filePath, merged);

        store.clear();
        for (const [key, value] of merged) store.set(key, value);
      }, { label: 'executor cache' });
      pendingWrites.clear();
      touchedKeys.clear();
      dirty = false;
    },

    size(): number {
      return store.size;
    },
  };
}

function readCacheStore(filePath: string, cap: number): Map<string, ExecResult> {
  // Map guarantees iteration order, which is the persisted LRU order.
  const store = new Map<string, ExecResult>();
  if (!existsSync(filePath)) return store;
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('invalid executor cache root');
    }
    for (const [key, value] of Object.entries(raw)) {
      const parsed = parseExecResult(value);
      if (parsed) store.set(key, parsed);
    }
    evictUntilWithinCap(store, cap);
  } catch {
    // A corrupt cache is disposable evidence acceleration, never report data.
    store.clear();
  }
  return store;
}

function writeCacheStore(
  filePath: string,
  store: Map<string, ExecResult>,
): void {
  // Keep the historical JSON object format. Property order carries LRU state.
  const serialized: Record<string, ExecResult> = {};
  for (const [key, value] of store) serialized[key] = value;
  writeJsonFileAtomic(filePath, serialized);
}

function evictUntilWithinCap(store: Map<string, ExecResult>, cap: number): void {
  if (!Number.isFinite(cap)) return;
  while (store.size > cap) {
    const oldest = store.keys().next().value;
    if (oldest == null) break;
    store.delete(oldest);
  }
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
  /** Executor effort 也进 key:effort 'low'/'medium'/'high' 改变 LLM 思考预算,
   *  输出/工具调用/分数都可能不同,跨 effort 共享 cache 会让报告 meta 标的 effort
   *  跟实际生成的 effort 不一致,违反"两份报告比分数前先比 cliVersion / effort"语义。 */
  effort?: string,
  /** artifact 内容指纹(整树 / 单文件哈)。本地 dir-skill 改 references/ 资产只动此值、不动 system,
   *  不进 key 会让改资产后命中旧输出 → 静默污染。空(baseline / 无 skill)等价无指纹。 */
  artifactContentHash?: string,
  /** External sample files that can alter executor output, currently mock return_file fixtures. */
  sampleExecutionDependencyHash?: string,
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
  const effortStr = effort || '';
  // executor + runtime + effort 进 cache key:同 model 名走不同 executor 或同 executor
  // 换 binary/SDK 版本时输出可能不同,旧 cache 不可复用。
  const hash = createHash('sha256')
    .update(`${model || ''}\n${system || ''}\n${prompt || ''}\n${cwd || ''}\n${isoStr}\n${executor || ''}\n${runtimeFingerprint || ''}\n${mockStr}\n${strictStr}\n${effortStr}\n${artifactContentHash || ''}\n${sampleExecutionDependencyHash || ''}`)
    .digest('hex')
    .slice(0, 16);
  return `v9:${hash}`;
}
