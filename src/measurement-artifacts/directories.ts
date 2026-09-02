import { DEFAULT_OBSERVE_HEALTH_DIR, DEFAULT_DOCTORS_DIR, DEFAULT_REPORTS_DIR } from './default-dirs.js';
import {
  legacyGlobalLayout,
  legacyProjectLayout,
  projectLayout,
} from '../omk-layout/index.js';
import { listMeasurementReportPaths } from './report-bundle.js';

/**
 * 测量产物的「项目优先 → 全局兜底」目录解析,镜像 managed 的 `resolveManagedDir`
 * (src/managed/store.ts)。测量产物绑用例集上下文(construct validity,不可全局化),
 * 默认落项目 `.omk/`,全局作显式 opt-in。
 *
 * 「记录优先」—— 目录里有匹配 report 文件才算数（不是「目录存在」），与 managed 同口径，
 * 避免空项目目录遮蔽全局数据。项目目录按**调用时** `cwd()` 求值（函数，不是 import 时
 * 冻结的常量），studio 长会话 per-request 解析才正确。
 */

/** dir 里是否有至少一个满足 match 的文件(短路,不读文件内容)。 */
function hasReports(dir: string): boolean {
  return listMeasurementReportPaths(dir).length > 0;
}

// —— observe/health（skill 健康度报告）——
// 每份报告使用自包含 bundle，目录已表达 observe health 域。

/** 项目级 observe-health 目录(相对调用时 cwd)。 */
export function projectObserveHealthDir(cwd: string = process.cwd()): string {
  return projectLayout(cwd).observeHealthDir;
}

/** 全局 observe-health 目录。 */
export function globalObserveHealthDir(): string {
  return DEFAULT_OBSERVE_HEALTH_DIR;
}

/** 权威 observe-health 目录:项目有报告取项目,否则全局有取全局,都空回项目(同 resolveManagedDir)。
 *  `global` 可注入(默认真实全局目录),仅供测试用受控 temp 目录复现 project↔global 兜底。 */
export function resolveObserveHealthDir(
  dir: string = projectObserveHealthDir(),
  global: string = globalObserveHealthDir(),
): string {
  const defaults = dir === projectObserveHealthDir() && global === globalObserveHealthDir();
  const candidates = defaults
    ? [dir, legacyProjectLayout().observeHealthDir, global, legacyGlobalLayout().observeHealthDir]
    : [dir, global];
  const found = candidates.find(hasReports);
  if (found !== undefined) return found;
  return dir;
}

// —— doctor（体检报告）——
// 每份报告使用自包含 bundle（兼容期仍读取 v1 扁平 report）。

/** 项目级 doctors 目录(相对调用时 cwd)。 */
export function projectDoctorsDir(cwd: string = process.cwd()): string {
  return projectLayout(cwd).doctorDir;
}

/** 全局 doctors 目录。 */
export function globalDoctorsDir(): string {
  return DEFAULT_DOCTORS_DIR;
}

/** 权威 doctors 目录:项目有报告取项目,否则全局有取全局,都空回项目(同 resolveManagedDir)。
 *  `global` 可注入(默认真实全局目录),仅供测试用受控 temp 目录复现 project↔global 兜底。 */
export function resolveDoctorsDir(
  dir: string = projectDoctorsDir(),
  global: string = globalDoctorsDir(),
): string {
  const defaults = dir === projectDoctorsDir() && global === globalDoctorsDir();
  const candidates = defaults
    ? [dir, legacyProjectLayout().doctorDir, global, legacyGlobalLayout().doctorDir]
    : [dir, global];
  const found = candidates.find(hasReports);
  if (found !== undefined) return found;
  return dir;
}

// —— eval（评测报告）——
// eval 与 observe health / doctor 不同：它不是「选一个权威目录」就够的展示列表，而是按 id
// 寻址的 store(get(id) / findByArtifactHash 被 resume / gold-compare / baseline 复用依赖)。
// 故记录优先在消费层合并项目与全局目录，此处只给写入侧与 --global
// 用的项目 / 全局目录 getter,不给 resolveReportsDir(单目录二选一会让目标 id 在另一目录时 get 落空)。

/** 项目级 reports 目录(相对调用时 cwd)。 */
export function projectReportsDir(cwd: string = process.cwd()): string {
  return projectLayout(cwd).evalDir;
}

/** 全局 reports 目录。 */
export function globalReportsDir(): string {
  return DEFAULT_REPORTS_DIR;
}
