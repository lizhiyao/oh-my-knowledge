/**
 * Executor result cache.
 *
 * Caches successful executor results to disk to avoid redundant API calls.
 * Cache key v6 = sha256(model + system + prompt + cwd + allowedSkills + executor +
 *                       runtime + mocks + mocksStrict + effort + artifactContentHash).
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
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ExecResult, ExecutorCache } from '../types/index.js';

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

  // 用 Map 替代 Record:Map 保证 iteration 顺序 = 插入顺序,LRU 淘汰用得上。
  // 老 JSON cache 文件仍按 Record<string, ExecResult> 写,反序列化时 Object.entries
  // 转 Map(Object 字段顺序在主流引擎里也是插入序,所以 LRU 信号不丢)。
  const store = new Map<string, ExecResult>();
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, ExecResult>;
      for (const [k, v] of Object.entries(raw)) store.set(k, v);
      // 加载完也 enforce 一次 cap,处理上次 process exit 前没保存到的极端膨胀。
      evictUntilWithinCap(store, cap);
    } catch {
      // 老 cache 坏了忽略 — 重跑会重建。
    }
  }

  let dirty = false;

  return {
    get(key: string): ExecResult | null {
      const v = store.get(key);
      if (v == null) return null;
      // LRU touch:命中时移到末尾(最新)。这样 evict 时永远从最旧端拿。
      store.delete(key);
      store.set(key, v);
      dirty = true;
      return v;
    },

    set(key: string, value: ExecResult): void {
      // 保留完整 ExecResult(含 turns / toolCalls):工具类 assertion (tool_called /
      // tool_input_contains / tools_called)和 diagnostic 要看 trace,砍掉的话 cached
      // rerun 进 grade() 时工具断言为空、diagnostic 没真实证据,跟 cold run 不一致。
      if (store.has(key)) store.delete(key);
      store.set(key, { ...value });
      evictUntilWithinCap(store, cap);
      dirty = true;
    },

    save(): void {
      if (!dirty) return;
      // 序列化时用普通 object,跟老 cache 文件格式兼容(读老报告不破)。
      // Map iteration 是插入序,生成的 object 字段顺序也保留 LRU 状态,下次加载继续生效。
      const obj: Record<string, ExecResult> = {};
      for (const [k, v] of store) obj[k] = v;
      writeFileSync(filePath, JSON.stringify(obj, null, 2));
      dirty = false;
    },

    size(): number {
      return store.size;
    },
  };
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
    .update(`${model || ''}\n${system || ''}\n${prompt || ''}\n${cwd || ''}\n${isoStr}\n${executor || ''}\n${runtimeFingerprint || ''}\n${mockStr}\n${strictStr}\n${effortStr}\n${artifactContentHash || ''}`)
    .digest('hex')
    .slice(0, 16);
  return `v6:${hash}`;
}
