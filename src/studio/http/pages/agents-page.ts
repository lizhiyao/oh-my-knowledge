import { buildAgentsPageModel, type AgentsPageModel } from '../../application/agents/agents-view.js';
import { AGENTS_INDEX_PATH } from '../page-paths.js';

export type AgentsPage = {
  readonly pageKind: 'agents';
  readonly model: AgentsPageModel;
};

/** 地址识别属装载器；宿主只按 `studioPages` 开关决定接不接管这一页。 */
export function isAgentsPath(path: string): boolean {
  return path === AGENTS_INDEX_PATH;
}

/**
 * 读取盘上的识别／采集报告。缺文件与坏文件在这里投影成页面状态而不是异常，
 * 因为两种情况都有可执行的下一步；只有目录整体不可读（抛错）才由宿主收敛成 503。
 */
export function loadAgentsPage(agentsDir: string): AgentsPage {
  return { pageKind: 'agents', model: buildAgentsPageModel(agentsDir) };
}
