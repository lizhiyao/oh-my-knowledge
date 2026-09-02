import { globalLayout, OMK_HOME } from '../shared/storage-layout.js';

/**
 * omk 所有默认产物的用户级根目录 —— 全部 `~/.oh-my-knowledge/*` 默认目录的单一基准,
 * 各目录都从这里派生,不在业务模块重复拼用户主目录与 OMK 根目录。
 *
 * `OMK_HOME` 环境变量可整体重定向这棵树：一处覆盖即把 eval / doctor / observe / state
 * (cache / trees / isolated-cwd / artifact-index)全部移走。测试用它一次性隔离,免得每加一个会从深层调用点写
 * 全局默认目录的写路径,都得单独补一个 per-dir env 兜底(否则注入不进的写路径会静默污染真实 home)。
 * 生产不设此变量时回落到 `~/.oh-my-knowledge`,行为不变。用户迁移整个数据目录也可用它。
 */
export { OMK_HOME };

const GLOBAL_LAYOUT = globalLayout();

/**
 * 耐久测量数据(要留、被 reportId 等引用,绝不自动删)的默认根目录。这几个是 cli 写、server(Studio)读
 * 的同一处,必须一致 —— 否则 cli 把产物写到一处、studio 从另一处读,页面就空。放在中立的 measurement-artifacts 层,
 * 让 cli/ 与 server/ 两个交付层都能合法 import 同一个常量,而不必让 server 反向 import cli
 * (那是 #242 清掉的分层倒挂)。
 */
export const DEFAULT_REPORTS_DIR: string = GLOBAL_LAYOUT.evalDir;
export const DEFAULT_OBSERVE_HEALTH_DIR: string = GLOBAL_LAYOUT.observeHealthDir;
export const DEFAULT_DOCTORS_DIR: string = GLOBAL_LAYOUT.doctorDir;

/**
 * 可重生的执行 scratch(删了能重建)统一收在 `state/` 子树下,跟上面的耐久数据物理分开 ——
 * 想清磁盘时「这一坨能整删」一眼可见。各 scratch 目录都派生自这个 state 根,避免散落硬编码。
 */
export const DEFAULT_STATE_DIR: string = GLOBAL_LAYOUT.stateDir;
export const DEFAULT_CACHE_DIR: string = GLOBAL_LAYOUT.cacheDir;
export const DEFAULT_ISOLATED_CWD_DIR: string = GLOBAL_LAYOUT.isolatedCwdDir;
export const DEFAULT_TREES_DIR: string = GLOBAL_LAYOUT.treesDir;

/**
 * 产物发现索引根：doctor / observe-health 项目本地落盘后，在全局这里留一张
 * 轻量目录卡片（指向项目里的真身），让 `omk studio` 可跨项目聚合这两类卡片。Core eval 不写索引卡片。索引是可重生的 scratch
 * (丢了重跑即重建,且当前项目+全局靠 live-scan 永远覆盖),故收在 state/ 子树。
 */
export const DEFAULT_ARTIFACT_INDEX_DIR: string = GLOBAL_LAYOUT.artifactIndexDir;
