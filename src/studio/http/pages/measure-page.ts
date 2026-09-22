import type { CoreStudioCatalog, CoreStudioRunCard, CoreStudioRunDetail } from '../../view-models/measure/core-runs.js';
import { MEASURE_DETAIL_PREFIX, MEASURE_INDEX_PATH } from '../page-paths.js';

/**
 * 评测两页的页面模型。缺页与数据源故障都在 Next 开始流式输出之前定下来：根 `loading.tsx`
 * 一旦先刷出壳层，页面里的 `notFound()` 就只能改视图、改不掉 200 状态码，所以「记录不存在」
 * 由宿主按与 `skill_not_found`／`managed_not_found`／`conversation_or_task_not_found` 同一口径回答，
 * 页面不再判第二次（#902 §三）。
 */
export type MeasurePage =
  | { pageKind: 'index'; runs: CoreStudioRunCard[] }
  // 详情页也带运行列表：外壳侧栏（#1055）要在详情页给出全部运行的切换入口。
  | { pageKind: 'run'; detail: CoreStudioRunDetail; runs: CoreStudioRunCard[] };

/** 地址识别属装载器（`src/studio/README.md`：`pages/` 的装载器「识别地址、装载证据、给出契约」），宿主只按路由组开关决定接不接管。 */
export function isMeasurePath(path: string): boolean {
  return path === MEASURE_INDEX_PATH || path.startsWith(MEASURE_DETAIL_PREFIX);
}

/** 运行 id 是单段稳定身份；畸形或越段一律按缺页处理，不拿去查数据源。 */
function runIdOf(path: string): string | undefined {
  if (!path.startsWith(MEASURE_DETAIL_PREFIX)) return undefined;
  const encoded = path.slice(MEASURE_DETAIL_PREFIX.length);
  if (!encoded || encoded.includes('/')) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export async function loadMeasurePage(catalog: CoreStudioCatalog, path: string): Promise<MeasurePage | undefined> {
  if (path === MEASURE_INDEX_PATH) return { pageKind: 'index', runs: await catalog.list() };
  const runId = runIdOf(path);
  if (runId === undefined) return undefined;
  const [detail, runs] = await Promise.all([catalog.get(runId), catalog.list()]);
  return detail ? { pageKind: 'run', detail, runs } : undefined;
}
