import 'server-only';
import { nextAgentsContext, nextHealthContext, nextInboxContext, nextKnowledgeContext, nextManagedContext, nextMeasureRunContext, nextMeasureRunsContext, nextObserveContext } from '../http/next-context';
import type { CoreStudioRunCard, CoreStudioRunDetail } from '../view-models/measure/core-runs';
import type { AgentsPage } from '../http/pages/agents-page';
import type { HealthPage } from '../http/pages/health-page';
import type { InboxPage } from '../http/pages/inbox-page';
import type { KnowledgePage } from '../http/pages/knowledge-page';
import type { ManagedPage } from '../http/pages/managed-page';
import type { ObservePage } from '../http/pages/observe-page';

// 宿主按请求注入 AsyncLocalStorage store；两侧模块经 globalThis 上的 Symbol.for 键
// 解析到同一个 ALS 实例。store 缺失是装配错误（StudioContextMissingError），
// 不是数据源失败，页面不得把它当作 SourceError 呈现。
// 页面只拿装载好的事实：缺页与数据源故障已在流式输出之前由宿主回答。
export function requestMeasureRuns(): CoreStudioRunCard[] {
  return nextMeasureRunsContext.get();
}

export function requestMeasureRun(): CoreStudioRunDetail {
  return nextMeasureRunContext.get();
}

export function requestObservePage(): ObservePage {
  return nextObserveContext.get();
}

export function requestKnowledgePage(): KnowledgePage {
  return nextKnowledgeContext.get();
}

export function requestInboxPage(): InboxPage {
  return nextInboxContext.get();
}

export function requestHealthPage(): HealthPage {
  return nextHealthContext.get();
}

export function requestManagedPage(): ManagedPage {
  return nextManagedContext.get();
}

export function requestAgentsPage(): AgentsPage {
  return nextAgentsContext.get();
}
