import { managedDir as projectManagedDir, resolveManagedDir } from '../../knowledge-artifacts/governance/index.js';

/**
 * 受管根目录按**请求**解析，不在启动时冻结 —— 否则长会话里会跟 `omk list` 分叉：Studio 启动时项目
 * `.omk/governance/managed` 还空、回退到 global，随后用户在项目里首次 `omk install`，`omk list` 下次会切到
 * project，而冻结了根目录的 Studio 仍盯着旧 global，页面与 CLI 不一致。cwd 在进程内不变，变的是目录里
 * 有没有记录，故每次请求重判。
 *   - 传函数 → 直接当解析器，每次请求调用（测试可注入受控解析器复现 project↔global 切换）；
 *   - 传字符串 → 固定该目录（显式覆盖 / 测试）；
 *   - 缺省 → 动态解析 project→global 权威目录，与 `omk list` 同口径。
 *
 * JSON 路由与 Next 页面宿主共用本函数，避免两条出口对同一个 `--managed-dir` 给出不同答案。
 */
export function resolveManagedRootOption(
  managedDir: string | (() => string) | undefined,
): () => string {
  if (typeof managedDir === 'function') return managedDir;
  if (managedDir !== undefined) return (): string => managedDir;
  return (): string => resolveManagedDir(projectManagedDir());
}
