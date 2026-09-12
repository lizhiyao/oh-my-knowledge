import 'server-only';
import { nextCatalogContext, nextInboxContext, nextKnowledgeContext, nextObserveContext } from '../http/next-context';
import type { CoreStudioCatalog } from '../view-models/core-runs';
import type { InboxPage } from '../http/inbox-page';
import type { KnowledgePage } from '../http/knowledge-page';
import type { ObservePage } from '../http/observe-page';

// 宿主按请求注入 AsyncLocalStorage store；两侧模块经 globalThis 上的 Symbol.for 键
// 解析到同一个 ALS 实例。store 缺失是装配错误（StudioContextMissingError），
// 不是数据源失败，页面不得把它当作 SourceError 呈现。
export function requestCatalog(): CoreStudioCatalog {
  return nextCatalogContext.get();
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
