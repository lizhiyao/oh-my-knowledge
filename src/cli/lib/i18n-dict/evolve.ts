import type { CliMessage } from './types.js';

export type EvolveMessageKey =
  | 'cli.evolve.specify_skill_path'
  | 'cli.evolve.section_header'
  | 'cli.evolve.round_baseline'
  | 'cli.evolve.round_error'
  | 'cli.evolve.round_done'
  | 'cli.evolve.summary'
  | 'cli.evolve.best_path'
  | 'cli.evolve.versions_saved'
  | 'cli.evolve.report_link'
  | 'cli.evolve.reject_core_decision'
  | 'cli.evolve.evidence_recorded_managed'
  | 'cli.evolve.snapshot_only_hint';

export const evolveDict: Record<EvolveMessageKey, CliMessage> = {
  'cli.evolve.specify_skill_path': {
    zh: '请指定 skill 文件路径, 例如: omk evolve skills/my-skill.md',
    en: 'Please specify a skill file path, e.g.: omk evolve skills/my-skill.md',
  },
  'cli.evolve.section_header': {
    zh: '\n=== Improve skill: {path} ===\n',
    en: '\n=== Improve skill: {path} ===\n',
  },
  'cli.evolve.round_baseline': {
    zh: '第 0 轮（基线）：score={score}（{cost}）\n',
    en: 'Round 0 (baseline): score={score} ({cost})\n',
  },
  'cli.evolve.round_error': {
    zh: '第 {round} 轮: ✗ 改进生成失败: {error}\n',
    en: 'Round {round}: ✗ improvement generation failed: {error}\n',
  },
  'cli.evolve.round_done': {
    zh: '第 {round} 轮: score={score} ({delta}) {status} ({cost})\n',
    en: 'Round {round}: score={score} ({delta}) {status} ({cost})\n',
  },
  'cli.evolve.summary': {
    zh: '\n✅ {start} → {final} (+{percent}%) | 共 {rounds} 轮 | {cost}\n',
    en: '\n✅ {start} → {final} (+{percent}%) | {rounds} rounds | {cost}\n',
  },
  'cli.evolve.best_path': {
    zh: '最优版本: {best} → {target}\n',
    en: 'Best: {best} → {target}\n',
  },
  'cli.evolve.versions_saved': {
    zh: '所有版本已保存在: {dir}/\n',
    en: 'All versions saved at: {dir}/\n',
  },
  'cli.evolve.report_link': {
    zh: '📊 查看报告：omk studio（报告 ID：{id}）\n',
    en: '📊 View report: omk studio (report id: {id})\n',
  },
  'cli.evolve.evidence_recorded_managed': {
    zh: '📌 已记入受管记录：{name}（verdict={verdict}）→ measurable。运行 omk promote {name} 接受为 promoted。\n',
    en: '📌 Recorded to managed record: {name} (verdict={verdict}) → measurable. Run omk promote {name} to accept as promoted.\n',
  },
  'cli.evolve.snapshot_only_hint': {
    zh: '📎 --snapshot-only：未写回 source，候选留在 {dir}/。挑选后手动应用，再 omk eval / omk promote。\n',
    en: '📎 --snapshot-only: source not modified; candidates kept in {dir}/. Apply your pick manually, then omk eval / omk promote.\n',
  },
  'cli.evolve.reject_core_decision': {
    zh: '（Core 决策门禁未通过）',
    en: ' (Core decision gate did not pass)',
  },
};
