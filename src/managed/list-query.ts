import { buildManagedListRows, type ManagedListRow } from './list-view.js';
import { loadAllManagedRecords } from './store.js';
import { probeSourceState } from './source-probe.js';

/**
 * 「读受管记录做展示」的单一编排:load 全部记录 → 逐条源探测(drift / 生命周期)→ 展示行。
 * omk list(CLI) 与 Studio(report-server) 共用同一口径,避免两个交付层各串一份。
 * dir 省略时走 loadAllManagedRecords 的 project→global 回退。
 */
export function listManagedRows(dir?: string): ManagedListRow[] {
  return buildManagedListRows(loadAllManagedRecords(dir), probeSourceState);
}
