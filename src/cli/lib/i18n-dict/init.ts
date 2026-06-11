import type { CliMessage } from './types.js';

export type InitMessageKey =
  | 'cli.init.scaffolded'
  | 'cli.init.next_steps_title'
  | 'cli.init.next_step_edit_samples'
  | 'cli.init.next_step_edit_skills'
  | 'cli.init.next_step_run'
  | 'cli.init.note_codex_executor'
  | 'cli.init.prefer_eval_init';

export const initDict: Record<InitMessageKey, CliMessage> = {
  'cli.init.scaffolded': {
    zh: '已初始化测评项目: {dir}',
    en: 'Eval project scaffolded at: {dir}',
  },
  'cli.init.next_steps_title': {
    zh: '下一步:',
    en: 'Next steps:',
  },
  'cli.init.next_step_edit_samples': {
    zh: '  1. 编辑 eval-samples.json，加入你要测的评测用例',
    en: '  1. Edit eval-samples.json to add your test cases',
  },
  'cli.init.next_step_edit_skills': {
    zh: '  2. 编辑 skills/code-review-v1/SKILL.md 和 skills/code-review-v2/SKILL.md, 为两个 skill 版本填入实际内容',
    en: '  2. Edit skills/code-review-v1/SKILL.md and skills/code-review-v2/SKILL.md with your skill versions',
  },
  'cli.init.next_step_run': {
    zh: '  3. 运行: omk eval --control code-review-v1 --treatment code-review-v2',
    en: '  3. Run: omk eval --control code-review-v1 --treatment code-review-v2',
  },
  'cli.init.note_codex_executor': {
    zh: '\n注: omk 评测时把 SKILL.md 整文(含 frontmatter)作为 system prompt 注入——跨 executor 一致(claude / codex / openai-api / gemini 都走同一条路径,不依赖任何 executor 的 native skill auto-discovery 或 Skill 工具机制)。frontmatter 在 prompt 头部对 model 行为无显著影响。\n模板带 Claude Code 兼容的 frontmatter(name + description)是为了让同一份 directory-skill 也能 deploy 到 Claude Code:把整个目录复制到 ~/.claude/skills/code-review-v1/(整目录,不是单个 SKILL.md),Claude SDK 才能识别。这是 omk 评测之外的 bonus,一份文件双向 dogfood。',
    en: '\nNote: during omk evaluation the full SKILL.md (frontmatter included) is injected as the system prompt — uniformly across executors (claude / codex / openai-api / gemini all take the same path; omk does not rely on any executor\'s native skill auto-discovery or Skill tool). Frontmatter has no measurable impact on model behavior in this position.\nThe template ships with Claude Code-compatible frontmatter (name + description) so the same directory-skill can also be deployed to Claude Code: copy the whole directory to ~/.claude/skills/code-review-v1/ (the directory, not just SKILL.md) so Claude SDK can recognize it. That is a bonus beyond omk evaluation — one source, two-way dogfood.',
  },
  'cli.init.prefer_eval_init': {
    zh: '\n提示：该命令已收敛到 omk eval init。omk init 仍长期可用，建议改用 omk eval init。',
    en: '\nTip: this command has converged to `omk eval init`. `omk init` still works long-term, but prefer `omk eval init`.',
  },
};
