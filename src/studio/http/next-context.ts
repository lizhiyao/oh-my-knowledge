import { AsyncLocalStorage } from 'node:async_hooks';
import type { CoreStudioRunCard, CoreStudioRunDetail } from '../view-models/measure/core-runs.js';
import type { AgentsPage } from './pages/agents-page.js';
import type { HealthPage } from './pages/health-page.js';
import type { InboxPage } from './pages/inbox-page.js';
import type { KnowledgePage } from './pages/knowledge-page.js';
import type { ManagedPage } from './pages/managed-page.js';
import type { ObservePage } from './pages/observe-page.js';

/**
 * 装配错误：宿主在渲染前没有注入该请求上下文。
 * 与数据源查询失败（studio_source_unavailable / 503）语义不同，不得混用。
 */
export class StudioContextMissingError extends Error {
  override readonly name = 'StudioContextMissingError';
  readonly code = 'studio_context_missing';

  constructor(readonly contextName: string) {
    super(`studio_context_missing: ${contextName}`);
  }
}

interface StudioRequestContext<T> {
  run<R>(store: T, fn: () => R): R;
  get(): T;
}

// AsyncLocalStorage 实例挂在 globalThis 的 Symbol.for 键上：Next 会把 web/ 单独打包，
// 与 CLI 模块图各持一份本模块，两侧经同一个键解析到同一个 ALS 实例，run/get 才能配对。
function defineStudioRequestContext<T>(name: string): StudioRequestContext<T> {
  const key = Symbol.for(`omk.studio.next.${name}`);
  const existing = Reflect.get(globalThis, key) as AsyncLocalStorage<T> | undefined;
  const storage = existing ?? new AsyncLocalStorage<T>();
  if (!existing) Reflect.set(globalThis, key, storage);
  return {
    run: (store, fn) => storage.run(store, fn),
    get: () => {
      const store = storage.getStore();
      if (store === undefined) throw new StudioContextMissingError(name);
      return store;
    },
  };
}

export const nextMeasureRunsContext = defineStudioRequestContext<CoreStudioRunCard[]>('measureRuns');
export const nextMeasureRunContext = defineStudioRequestContext<CoreStudioRunDetail>('measureRun');
export const nextObserveContext = defineStudioRequestContext<ObservePage>('observe');
export const nextKnowledgeContext = defineStudioRequestContext<KnowledgePage>('knowledge');
export const nextInboxContext = defineStudioRequestContext<InboxPage>('inbox');
export const nextHealthContext = defineStudioRequestContext<HealthPage>('health');
export const nextManagedContext = defineStudioRequestContext<ManagedPage>('managed');
export const nextAgentsContext = defineStudioRequestContext<AgentsPage>('agents');
