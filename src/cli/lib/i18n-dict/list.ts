import type { CliMessage } from './types.js';

export type ListMessageKey =
  | 'cli.list.header'
  | 'cli.list.empty'
  | 'cli.list.empty_hint'
  | 'cli.list.col_name'
  | 'cli.list.col_kind'
  | 'cli.list.col_state'
  | 'cli.list.col_verdict'
  | 'cli.list.col_evidence'
  | 'cli.list.col_source'
  | 'cli.list.drift_note'
  | 'cli.list.unreachable_note'
  | 'cli.list.promoted_note'
  | 'cli.list.production_gap_note'
  | 'cli.list.legend';

export const listDict: Record<ListMessageKey, CliMessage> = {
  'cli.list.header': {
    zh: '受管 skill（{scope}，{count} 条）\n',
    en: 'Managed skills ({scope}, {count})\n',
  },
  'cli.list.empty': {
    zh: '没有受管记录。\n',
    en: 'No managed records.\n',
  },
  'cli.list.empty_hint': {
    zh: '用 omk install <skill> 登记并分发一个 skill 后，它会出现在这里。\n',
    en: 'Run omk install <skill> to register and distribute a skill; it will show up here.\n',
  },
  'cli.list.col_name': { zh: '名称', en: 'NAME' },
  'cli.list.col_kind': { zh: '类型', en: 'KIND' },
  'cli.list.col_state': { zh: '状态', en: 'STATE' },
  'cli.list.col_verdict': { zh: 'VERDICT', en: 'VERDICT' },
  'cli.list.col_evidence': { zh: '证据', en: 'EVIDENCE' },
  'cli.list.col_source': { zh: '源', en: 'SOURCE' },
  'cli.list.drift_note': {
    zh: '⚠️ = 源内容已漂移、脱离证据（stale）；重跑 omk eval 重新取证。\n',
    en: '⚠️ = source content drifted off its evidence (stale); re-run omk eval to re-measure.\n',
  },
  'cli.list.unreachable_note': {
    zh: '? = 源此处不可达 / 拒读，drift 未核（非 stale）；本地 git 源请在原仓库根目录跑 omk list。\n',
    en: '? = source unreachable / refused here, drift unchecked (not stale); for a local git source run omk list from the original repo root.\n',
  },
  'cli.list.promoted_note': {
    zh: '✓ = 当前版本已按证据人工接受为 promoted（omk promote）。\n',
    en: '✓ = current version accepted as promoted on evidence (omk promote).\n',
  },
  'cli.list.production_gap_note': {
    zh: '🔬 = observe 在线上检测到生产盲区（与生命周期无关的版本无关信号）；建议补对应用例后重跑 omk eval。\n',
    en: '🔬 = observe detected a production gap in real traffic (a version-agnostic signal, orthogonal to lifecycle); add matching samples and re-run omk eval.\n',
  },
  'cli.list.legend': {
    zh: '证据列 = 当前有效 / 全部（历史含旧内容证据，供回滚）。\n',
    en: 'EVIDENCE column = current / total (history keeps old-content evidence for rollback).\n',
  },
};
