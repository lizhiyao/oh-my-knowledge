import type { CliMessage } from './types.js';

export type RunMessageKey =
  | 'cli.progress.preflight_starting'
  | 'cli.progress.sample_retry'
  | 'cli.progress.sample_error'
  | 'cli.progress.sample_executing'
  | 'cli.progress.sample_exec_done'
  | 'cli.progress.output_preview'
  | 'cli.progress.judging'
  | 'cli.progress.judged'
  | 'cli.progress.skipped'
  | 'cli.progress.sample_done'
  | 'cli.progress.sample_failed_done'
  | 'cli.run.batch_verdict_header'
  | 'cli.run.codex_fallback_hint'
  | 'cli.run.codex_auth_hint'
  | 'cli.run.codex_model_hint'
  | 'cli.run.openai_api_auth_hint'
  | 'cli.run.openai_api_model_hint'
  | 'cli.run.anthropic_api_auth_hint'
  | 'cli.run.anthropic_api_model_hint';

export const runDict: Record<RunMessageKey, CliMessage> = {
  'cli.progress.preflight_starting': {
    zh: '⏳ 正在预检模型连通性...\n',
    en: '⏳ Preflight: checking model connectivity...\n',
  },
  'cli.progress.sample_retry': {
    zh: '[{i}/{n}] {sample}/{variant} 🔄 重试 {attempt}/{max}...\n',
    en: '[{i}/{n}] {sample}/{variant} 🔄 retry {attempt}/{max}...\n',
  },
  'cli.progress.sample_error': {
    zh: '[{i}/{n}] {sample}/{variant} ⚠️ {error}\n',
    en: '[{i}/{n}] {sample}/{variant} ⚠️ {error}\n',
  },
  'cli.progress.sample_executing': {
    zh: '[{i}/{n}] {sample}/{variant} ⏳ 执行中...\n',
    en: '[{i}/{n}] {sample}/{variant} ⏳ running...\n',
  },
  'cli.progress.sample_exec_done': {
    zh: '[{i}/{n}] {sample}/{variant} 执行完成 {ms}ms {input}+{output} tokens{cost}\n',
    en: '[{i}/{n}] {sample}/{variant} done {ms}ms {input}+{output} tokens{cost}\n',
  },
  'cli.progress.output_preview': {
    zh: '  输出预览: {preview}\n',
    en: '  output preview: {preview}\n',
  },
  'cli.progress.judging': {
    zh: '[{i}/{n}] {sample}/{variant} 评委评审中{dim}...\n',
    en: '[{i}/{n}] {sample}/{variant} judging{dim}...\n',
  },
  'cli.progress.judged': {
    zh: '[{i}/{n}] {sample}/{variant} 评委评审完成{dim} score={score}\n',
    en: '[{i}/{n}] {sample}/{variant} judged{dim} score={score}\n',
  },
  'cli.progress.skipped': {
    zh: '[{i}/{n}] {sample}/{variant} ⏭ 已跳过 (已有结果)\n',
    en: '[{i}/{n}] {sample}/{variant} ⏭ skipped (cached)\n',
  },
  'cli.progress.sample_done': {
    zh: '[{i}/{n}] {sample}/{variant} ✓ {ms}ms {input}+{output} tokens{cost}{score}\n',
    en: '[{i}/{n}] {sample}/{variant} ✓ {ms}ms {input}+{output} tokens{cost}{score}\n',
  },
  'cli.progress.sample_failed_done': {
    zh: '[{i}/{n}] {sample}/{variant} ⚠️ {ms}ms {input}+{output} tokens{cost} error={error}\n',
    en: '[{i}/{n}] {sample}/{variant} ⚠️ {ms}ms {input}+{output} tokens{cost} error={error}\n',
  },
  'cli.run.batch_verdict_header': {
    zh: '批量评测结论：{status}（{passed}/{total} 通过）',
    en: 'Batch verdict: {status} ({passed}/{total} passed)',
  },
  'cli.run.codex_fallback_hint': {
    zh: '\n提示：当前失败的是 Claude 系列执行器。先确认 Claude Code 已登录；如果你在 Codex 环境里，也可以把模型运行参数改为：{flags}。{codexModelHint}codex 执行器目前不会报告 costUSD。',
    en: '\nHint: the failing runtime is Claude-based. First confirm Claude Code is authenticated; in a Codex environment, you can also switch the model runtime flags to: {flags}. {codexModelHint} The codex executor does not report costUSD yet.',
  },
  'cli.run.codex_auth_hint': {
    zh: '\n提示：当前失败的是 Codex 系列执行器。先确认 Codex CLI / SDK 已安装并完成登录；如果你有 Claude Code 可用，可以改走 Claude：{claudeFlags}；如果要继续走 OpenAI API，可以改为：{openaiFlags}，并设置 OPENAI_API_KEY。openai-api 会按 API 响应记录 token / cost。',
    en: '\nHint: the failing runtime is Codex-based. First confirm the Codex CLI / SDK is installed and authenticated; if Claude Code is available, switch to Claude: {claudeFlags}; to stay on the OpenAI API path, switch to: {openaiFlags}, and set OPENAI_API_KEY. openai-api records token / cost from API responses.',
  },
  'cli.run.codex_model_hint': {
    zh: '\n提示：当前失败的是 Codex 系列执行器，但模型名看起来不可用。可以先按本机 Codex 配置重试：{codexFlags}（{codexModelHint}）；也可以先运行 `{codexExec}` 验证模型是否可用。若只是想先跑通，可以改走 Claude：{claudeFlags}；或继续走 OpenAI API：{openaiFlags}，并设置 OPENAI_API_KEY。',
    en: '\nHint: the failing runtime is Codex-based, but the model name appears unavailable. Retry with the local Codex config model: {codexFlags} ({codexModelHint}); you can also run `{codexExec}` to verify the model. To just get a first run through, switch to Claude: {claudeFlags}; or stay on the OpenAI API path: {openaiFlags}, and set OPENAI_API_KEY.',
  },
  'cli.run.openai_api_auth_hint': {
    zh: '\n提示：当前失败的是 OpenAI API 执行器。请检查 OPENAI_API_KEY / OPENAI_BASE_URL 是否可用，并确认模型名对当前端点可用。',
    en: '\nHint: the failing runtime is the OpenAI API executor. Check OPENAI_API_KEY / OPENAI_BASE_URL and confirm the model is available on that endpoint.',
  },
  'cli.run.openai_api_model_hint': {
    zh: '\n提示：当前失败的是 OpenAI API 执行器，但模型名看起来对当前端点不可用。请检查 --model / --judge-models、OPENAI_BASE_URL 与账号权限是否匹配。',
    en: '\nHint: the failing runtime is the OpenAI API executor, but the model name appears unavailable on the current endpoint. Check --model / --judge-models, OPENAI_BASE_URL, and account access.',
  },
  'cli.run.anthropic_api_auth_hint': {
    zh: '\n提示：当前失败的是 Anthropic API 执行器。请检查 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 是否可用，并确认模型名对当前端点可用。',
    en: '\nHint: the failing runtime is the Anthropic API executor. Check ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL and confirm the model is available on that endpoint.',
  },
  'cli.run.anthropic_api_model_hint': {
    zh: '\n提示：当前失败的是 Anthropic API 执行器，但模型名看起来对当前端点不可用。请检查 --model / --judge-models、ANTHROPIC_BASE_URL 与账号权限是否匹配。',
    en: '\nHint: the failing runtime is the Anthropic API executor, but the model name appears unavailable on the current endpoint. Check --model / --judge-models, ANTHROPIC_BASE_URL, and account access.',
  },
};
