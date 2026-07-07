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
  | 'cli.gen.append_done'
  | 'cli.gen.append_single_only'
  | 'cli.gen.review_hint'
  | 'cli.gen.claude_auth_hint'
  | 'cli.gen.codex_auth_hint'
  | 'cli.gen.openai_api_auth_hint'
  | 'cli.gen.anthropic_api_auth_hint'
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
    zh: '\n共生成 {n} 份 eval-samples。下一步：\n  1. 人工审查生成的评测用例，删掉不可信样本，补边界、反例\n  2. 预览任务：omk eval --batch --dry-run\n  3. 跑评测：omk eval --batch',
    en: '\nGenerated {n} eval-samples files. Next steps:\n  1. Review the generated samples; drop weak cases and add boundary / counterexamples\n  2. Preview the task plan: omk eval --batch --dry-run\n  3. Run the eval: omk eval --batch',
  },
  'cli.gen.specify_skill_path': {
    zh: '请指定 skill 文件路径, 例如: omk sample skills/my-skill.md',
    en: 'Please specify a skill file path, e.g.: omk sample skills/my-skill.md',
  },
  'cli.gen.samples_already_exists': {
    zh: 'eval-samples 已存在。要补场景请加 --append（常配 --focus）；要继续评测，运行：{command}',
    en: 'eval-samples already exist. To add scenarios, use --append (often with --focus); to continue, run: {command}',
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
  'cli.gen.append_done': {
    zh: '✅ 新增 {added} 条用例（撞 id 已自动改名），合并后共 {total} 条 → {path}{cost}\n',
    en: '✅ Appended {added} samples (colliding ids auto-renamed), {total} total → {path}{cost}\n',
  },
  'cli.gen.append_single_only': {
    zh: '--append 目前仅支持单 skill 模式，不能与 --batch / --from-traces / --fix 同用。\n',
    en: '--append currently supports single-skill mode only; it cannot be combined with --batch / --from-traces / --fix.\n',
  },
  'cli.gen.review_hint': {
    zh: '\n下一步：\n  1. 人工审查生成的评测用例，删掉不可信样本，补边界、反例\n  2. 预览任务：{command} --dry-run\n  3. 跑评测：{command}',
    en: '\nNext steps:\n  1. Review the generated samples; drop weak cases and add boundary / counterexamples\n  2. Preview the task plan: {command} --dry-run\n  3. Run the eval: {command}',
  },
  'cli.gen.claude_auth_hint': {
    zh: '\n提示：当前 sample 生成使用 Claude 系列执行器。先确认 Claude Code 已安装并完成登录；如果你在 Codex 环境里，可以改用：{codexFlags}；如果要走 OpenAI API，可以改用：{openaiFlags}，并设置 OPENAI_API_KEY。',
    en: '\nHint: sample generation is using a Claude-based executor. First confirm Claude Code is installed and authenticated; in a Codex environment, switch to: {codexFlags}; to use the OpenAI API path, switch to: {openaiFlags}, and set OPENAI_API_KEY.',
  },
  'cli.gen.codex_auth_hint': {
    zh: '\n提示：当前 sample 生成使用 Codex 系列执行器。先确认 Codex CLI / SDK 已安装并完成登录；如果你有 Claude Code 可用，可以改用：{claudeFlags}；如果要走 OpenAI API，可以改用：{openaiFlags}，并设置 OPENAI_API_KEY。',
    en: '\nHint: sample generation is using a Codex-based executor. First confirm the Codex CLI / SDK is installed and authenticated; if Claude Code is available, switch to: {claudeFlags}; to use the OpenAI API path, switch to: {openaiFlags}, and set OPENAI_API_KEY.',
  },
  'cli.gen.openai_api_auth_hint': {
    zh: '\n提示：当前 sample 生成使用 OpenAI API 执行器。请检查 OPENAI_API_KEY / OPENAI_BASE_URL 是否可用，并确认模型名对当前端点可用；如果只是想先跑通，也可以改用：{claudeFlags}，或：{codexFlags}。',
    en: '\nHint: sample generation is using the OpenAI API executor. Check OPENAI_API_KEY / OPENAI_BASE_URL and confirm the model is available on that endpoint; to just get a first run through, you can also switch to: {claudeFlags}, or: {codexFlags}.',
  },
  'cli.gen.anthropic_api_auth_hint': {
    zh: '\n提示：当前 sample 生成使用 Anthropic API 执行器。请检查 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 是否可用，并确认模型名对当前端点可用；如果你有 Claude Code 可用，也可以改用：{claudeFlags}。',
    en: '\nHint: sample generation is using the Anthropic API executor. Check ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL and confirm the model is available on that endpoint; if Claude Code is available, you can also switch to: {claudeFlags}.',
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
