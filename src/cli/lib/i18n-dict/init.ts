import type { CliMessage } from './types.js';

export type InitMessageKey =
  | 'cli.init.scaffolded'
  | 'cli.init.next_steps_title'
  | 'cli.init.next_step_run'
  | 'cli.init.next_step_executor'
  | 'cli.init.next_step_customize'
  | 'cli.init.note_codex_executor';

export const initDict: Record<InitMessageKey, CliMessage> = {
  'cli.init.scaffolded': {
    zh: '已初始化 omk 项目：{dir}',
    en: 'omk project initialized at: {dir}',
  },
  'cli.init.next_steps_title': {
    zh: '下一步：',
    en: 'Next steps:',
  },
  // 先让用户「无需改任何文件直接跑通」——脚手架的用例与 skill 本身可跑(已过合规校验),
  // 跑出第一份报告是冷启动最该先发生的事;「换成你自己的」放到跑通之后。这也消除了
  // 主 README「不用改任何文件」与旧 init「先编辑」的矛盾。
  'cli.init.next_step_run': {
    zh: '  1. 直接跑通（无需先改任何文件）：omk eval --control code-review-v1 --treatment code-review-v2',
    en: '  1. Run it as-is (no edits needed): omk eval --control code-review-v1 --treatment code-review-v2',
  },
  'cli.init.next_step_executor': {
    zh: '     默认执行器与评委用 claude CLI，需先装好并登录；想换别的模型或离线跑（无需 API key）见文档「执行器」。',
    en: '     The default executor and judge use the claude CLI (install and log in first); to use another model or run offline (no API key) see the Executors docs.',
  },
  'cli.init.next_step_customize': {
    zh: '  2. 跑通后，把 skills/code-review-v1/SKILL.md 和 skills/code-review-v2/SKILL.md 与 eval-samples.json 换成你自己的 skill 和用例',
    en: '  2. Once it runs, replace skills/code-review-v1/SKILL.md and skills/code-review-v2/SKILL.md and eval-samples.json with your own skills and cases',
  },
  'cli.init.note_codex_executor': {
    zh: '\n注: omk 评测时把 SKILL.md 整文(含 frontmatter)作为 system prompt 注入——跨 executor 一致(claude / codex / openai-api / gemini 都走同一条路径,不依赖任何 executor 的 native skill auto-discovery 或 Skill 工具机制)。frontmatter 在 prompt 头部对 model 行为无显著影响。\n模板带 Claude Code 兼容的 frontmatter(name + description)是为了让同一份 directory-skill 也能 deploy 到 Claude Code:把整个目录复制到 ~/.claude/skills/code-review-v1/(整目录,不是单个 SKILL.md),Claude SDK 才能识别。这是 omk 评测之外的 bonus,一份文件双向 dogfood。',
    en: '\nNote: during omk evaluation the full SKILL.md (frontmatter included) is injected as the system prompt — uniformly across executors (claude / codex / openai-api / gemini all take the same path; omk does not rely on any executor\'s native skill auto-discovery or Skill tool). Frontmatter has no measurable impact on model behavior in this position.\nThe template ships with Claude Code-compatible frontmatter (name + description) so the same directory-skill can also be deployed to Claude Code: copy the whole directory to ~/.claude/skills/code-review-v1/ (the directory, not just SKILL.md) so Claude SDK can recognize it. That is a bonus beyond omk evaluation — one source, two-way dogfood.',
  },
};
