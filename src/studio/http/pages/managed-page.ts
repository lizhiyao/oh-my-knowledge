import { listManagedRows, loadAllManagedRecords } from '../../../knowledge-artifacts/governance/index.js';
import {
  projectManagedListRow,
  projectManagedTimeline,
  type ManagedListPresentation,
  type ManagedVersionSegment,
} from '../../application/knowledge/managed-format.js';

/**
 * 受管页面模型：只带呈现所需的最小投影。
 *
 * 记录的 `source.locator`／`url` 是用户机器上的绝对路径，不进页面模型 —— RSC 会把 props 序列化进
 * 页面负载，直接把整条记录交给组件等于把文件系统路径发给浏览器。列表的 `sourceLabel` 是公开口径
 * （/api/managed 早已返回），保留。
 */
export type ManagedPage =
  | { pageKind: 'list'; rows: ManagedListPresentation[] }
  | {
    pageKind: 'detail';
    name: string;
    artifactKind: string;
    sourceKind: string;
    contentHash: string;
    installedAt: string;
    segments: ManagedVersionSegment[];
  };

export type ManagedPageLoad =
  | { status: 'ok'; page: ManagedPage }
  | { status: 'record_not_found' };

const LIST_PATH = '/knowledge/managed';
const DETAIL_PREFIX = '/knowledge/managed/';

/** 受管页面组是否属于本宿主；裁掉页面组的宿主不接管这些路径。 */
export function isManagedPath(path: string): boolean {
  return path === LIST_PATH || path.startsWith(DETAIL_PREFIX);
}

/** 记录 id 是稳定身份（hash(kind, name)），单段身份；畸形或越段一律按缺页处理，不拿去拼路径。 */
function singleSegment(encoded: string): string | undefined {
  if (!encoded || encoded.includes('/')) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export function loadManagedPage(managedRoot: string, path: string): ManagedPageLoad {
  if (path === LIST_PATH) {
    return {
      status: 'ok',
      page: { pageKind: 'list', rows: listManagedRows(managedRoot).map(projectManagedListRow) },
    };
  }
  const id = singleSegment(path.slice(DETAIL_PREFIX.length));
  const record = id === undefined
    ? undefined
    : loadAllManagedRecords(managedRoot).find((item) => item.id === id);
  if (!record) return { status: 'record_not_found' };
  return {
    status: 'ok',
    page: {
      pageKind: 'detail',
      name: record.name,
      artifactKind: record.kind,
      sourceKind: record.source.sourceKind,
      contentHash: record.contentHash,
      installedAt: record.installedAt,
      segments: projectManagedTimeline(record),
    },
  };
}
