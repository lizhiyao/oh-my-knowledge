import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * omk 所有默认产物的用户级根目录 —— 全部 `~/.oh-my-knowledge/*` 默认目录的单一基准,
 * 各目录都从这里派生,不在散落各处重复拼 `join(homedir(), '.oh-my-knowledge', ...)`。
 */
export const OMK_HOME: string = join(homedir(), '.oh-my-knowledge');

/**
 * 耐久测量数据(要留、被 reportId 等引用,绝不自动删)的默认根目录。这几个是 cli 写、server(Studio)读
 * 的同一处,必须一致 —— 否则 cli 把产物写到一处、studio 从另一处读,页面就空。放在中立的 eval-core 层,
 * 让 cli/ 与 server/ 两个交付层都能合法 import 同一个常量,而不必让 server 反向 import cli
 * (那是 #242 清掉的分层倒挂)。
 */
export const DEFAULT_REPORTS_DIR: string = join(OMK_HOME, 'reports');
export const DEFAULT_OBSERVE_HEALTH_DIR: string = join(OMK_HOME, 'observe-health');
export const DEFAULT_DOCTORS_DIR: string = join(OMK_HOME, 'doctors');

/**
 * 可重生的执行 scratch(删了能重建)统一收在 `state/` 子树下,跟上面的耐久数据物理分开 ——
 * 想清磁盘时「这一坨能整删」一眼可见。各 scratch 目录都派生自这个 state 根,避免散落硬编码。
 */
export const DEFAULT_STATE_DIR: string = join(OMK_HOME, 'state');
export const DEFAULT_CACHE_DIR: string = join(DEFAULT_STATE_DIR, 'cache');
export const DEFAULT_ISOLATED_CWD_DIR: string = join(DEFAULT_STATE_DIR, 'isolated-cwd');
export const DEFAULT_TREES_DIR: string = join(DEFAULT_STATE_DIR, 'trees');
export const DEFAULT_JOBS_DIR: string = join(DEFAULT_STATE_DIR, 'jobs');

/**
 * 产物发现索引根:每类测量产物(report / doctor / observe-health)项目本地落盘后,在全局这里留一张
 * 轻量目录卡片(指向项目里的真身),让 `omk studio` 跨项目聚合成「机器级总览」。索引是可重生的 scratch
 * (丢了重跑即重建,且当前项目+全局靠 live-scan 永远覆盖),故收在 state/ 子树。
 */
export const DEFAULT_ARTIFACT_INDEX_DIR: string = join(DEFAULT_STATE_DIR, 'artifact-index');
