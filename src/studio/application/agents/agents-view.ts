/**
 * 本机 Agent 页面投影：把 `omk agents` 落盘的两份报告读成页面模型。
 *
 * 页面只呈现 OMK 已经记录下来的事实，不在此处重新扫描用户机器：识别与采集都由 CLI 显式触发，
 * 页面刷新不会改变磁盘上的证据。三份状态必须分开表达——「从未跑过」「记录读不动」「有记录」
 * 是三种不同的用户动作，合并成一个空列表会让人以为本机什么都没装。
 */

import {
  agentStorageLayout,
  AgentCollectionReportOutdatedError,
  loadAgentCollectionReport,
  loadAgentInventoryReport,
} from '../../../observability/agents/index.js';
import type {
  AgentCollectionReport,
  AgentInventoryReport,
  AgentStorageLayout,
} from '../../../observability/agents/index.js';

/**
 * 单份报告的可读状态。`unreadable` 只说读不动，不猜原因，也不拿旧数据顶替；
 * `outdated` 是文件读得懂、但口径已被取代，用户只需要重新采集。
 */
type AgentsReportState<T> =
  | { readonly status: 'ready'; readonly report: T }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'outdated'; readonly foundVersion: string };

export interface AgentsPageModel {
  readonly layout: AgentStorageLayout;
  readonly inventory: AgentsReportState<AgentInventoryReport>;
  readonly collection: AgentsReportState<AgentCollectionReport>;
}

function readReport<T>(load: () => T | undefined): AgentsReportState<T> {
  let report: T | undefined;
  try {
    report = load();
  } catch (cause) {
    if (cause instanceof AgentCollectionReportOutdatedError) {
      return { status: 'outdated', foundVersion: cause.foundVersion };
    }
    return { status: 'unreadable' };
  }
  return report === undefined ? { status: 'missing' } : { status: 'ready', report };
}

/**
 * `agentsDir` 是采集产物根目录（`omk agents --dir` 的落点），默认由调用方给全局布局。
 * 目录本身不存在不是错误：那正是「还没跑过 `omk agents list`」的状态。
 */
export function buildAgentsPageModel(agentsDir: string): AgentsPageModel {
  const layout = agentStorageLayout(agentsDir);
  return {
    layout,
    inventory: readReport(() => loadAgentInventoryReport(layout)),
    collection: readReport(() => loadAgentCollectionReport(layout.observeAgentsDir)),
  };
}
