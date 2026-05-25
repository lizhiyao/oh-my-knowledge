import type { CliMessage } from './types.js';

export type GenMessageKey =
  | 'cli.gen.skill_skipped_existing'
  | 'cli.gen.skill_generating'
  | 'cli.gen.skill_generating_auto'
  | 'cli.gen.skill_done'
  | 'cli.gen.skill_failed'
  | 'cli.gen.batch_none_needed'
  | 'cli.gen.batch_summary'
  | 'cli.gen.specify_skill_path'
  | 'cli.gen.samples_already_exists'
  | 'cli.gen.single_generating'
  | 'cli.gen.single_generating_auto'
  | 'cli.gen.single_done'
  | 'cli.gen.review_hint'
  | 'cli.gen.failed'
  | 'cli.gen.focus_applied';

export const genDict: Record<GenMessageKey, CliMessage> = {
  'cli.gen.skill_skipped_existing': {
    zh: '⏭️  {name}: eval-samples 已存在, 跳过\n',
    en: '⏭️  {name}: eval-samples already exists, skipping\n',
  },
  'cli.gen.skill_generating': {
    zh: '🔄 {name}: 正在生成 {count} 条评测用例...\n',
    en: '🔄 {name}: generating {count} test cases...\n',
  },
  'cli.gen.skill_generating_auto': {
    zh: '🔄 {name}: 正在生成评测用例（数量由 LLM 按 skill 类型自动判断）...\n',
    en: '🔄 {name}: generating test cases (count auto-decided by LLM based on skill type)...\n',
  },
  'cli.gen.skill_done': {
    zh: '✅ {name}: 已生成 {n} 条用例 → {path}{cost}\n',
    en: '✅ {name}: generated {n} samples → {path}{cost}\n',
  },
  'cli.gen.skill_failed': {
    zh: '❌ {name}: {message}\n',
    en: '❌ {name}: {message}\n',
  },
  'cli.gen.batch_none_needed': {
    zh: '没有需要生成的 eval-samples (所有 skill 都已有配对文件)',
    en: 'No eval-samples need generating (all skills already have paired files)',
  },
  'cli.gen.batch_summary': {
    zh: '\n共生成 {n} 份 eval-samples, 请审查后运行: omk eval --batch',
    en: '\nGenerated {n} eval-samples files. Review them, then run: omk eval --batch',
  },
  'cli.gen.specify_skill_path': {
    zh: '请指定 skill 文件路径, 例如: omk sample skills/my-skill.md',
    en: 'Please specify a skill file path, e.g.: omk sample skills/my-skill.md',
  },
  'cli.gen.samples_already_exists': {
    zh: 'eval-samples.json 已存在。如需覆盖请先删除该文件。',
    en: 'eval-samples.json already exists. Delete it first if you want to overwrite.',
  },
  'cli.gen.single_generating': {
    zh: '🔄 正在生成 {count} 条评测用例...\n',
    en: '🔄 Generating {count} test cases...\n',
  },
  'cli.gen.single_generating_auto': {
    zh: '🔄 正在生成评测用例（数量由 LLM 按 skill 类型自动判断）...\n',
    en: '🔄 Generating test cases (count auto-decided by LLM based on skill type)...\n',
  },
  'cli.gen.single_done': {
    zh: '✅ 已生成 {n} 条用例 → {path}{cost}\n',
    en: '✅ Generated {n} samples → {path}{cost}\n',
  },
  'cli.gen.review_hint': {
    zh: '\n请审查生成的评测用例后运行: omk eval',
    en: '\nReview the generated test cases, then run: omk eval',
  },
  'cli.gen.failed': {
    zh: '生成失败: {message}',
    en: 'Generation failed: {message}',
  },
  'cli.gen.focus_applied': {
    zh: '🎯 场景重点（--focus）：{focus}\n',
    en: '🎯 Focus scenarios (--focus): {focus}\n',
  },
};
