import type { CliMessage } from './types.js';

export type EvolveMessageKey =
  | 'cli.evolve.specify_skill_path'
  | 'cli.evolve.section_header'
  | 'cli.evolve.round_baseline'
  | 'cli.evolve.round_baseline_reused'
  | 'cli.evolve.round_error'
  | 'cli.evolve.round_done'
  | 'cli.evolve.summary'
  | 'cli.evolve.best_path'
  | 'cli.evolve.versions_saved'
  | 'cli.evolve.report_link'
  | 'cli.evolve.holdout_active'
  | 'cli.evolve.holdout_disabled'
  | 'cli.evolve.gate_underpowered'
  | 'cli.evolve.generalization';

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
  'cli.evolve.round_baseline_reused': {
    zh: '第 0 轮（基线）：score={score}（复用最新 eval 报告）\n',
    en: 'Round 0 (baseline): score={score} (reused latest eval report)\n',
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
  'cli.evolve.holdout_active': {
    zh: '🔀 holdout 切分：训练 {train} / 验收 {holdout}，accept 看 holdout 分（防 train-on-test）\n',
    en: '🔀 Holdout split: {train} train / {holdout} holdout; accepted on holdout score (guards train-on-test)\n',
  },
  'cli.evolve.holdout_disabled': {
    zh: '⚠️ holdout-ratio={ratio} 样本太少无法切分，已回退全集打分\n',
    en: '⚠️ holdout-ratio={ratio} too few samples to split; using full-set scoring\n',
  },
  'cli.evolve.gate_underpowered': {
    zh: '⚠️ 决策样本量不足以做显著性门禁，本轮退回点估计接受；增大用例集或降 --holdout-ratio 可启用严格门\n',
    en: '⚠️ Too few decision samples for the significance gate; fell back to point-estimate accept. Add samples or lower --holdout-ratio to enable the strict gate\n',
  },
  'cli.evolve.generalization': {
    zh: '🔒 锁定 test 集（{count} 条，全程不参与选择）：泛化分 {score}\n',
    en: '🔒 Locked test set ({count} samples, never used for selection): generalization {score}\n',
  },
};
