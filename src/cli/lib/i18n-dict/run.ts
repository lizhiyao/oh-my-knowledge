import type { CliMessage } from './types.js';

export type RunMessageKey =
  | 'cli.run.custom_executor_path'
  | 'cli.run.summary.verdict'
  | 'cli.run.summary.execution'
  | 'cli.run.summary.evaluation'
  | 'cli.run.summary.state'
  | 'cli.run.summary.reasons'
  | 'cli.run.summary.run'
  | 'cli.run.next.progress'
  | 'cli.run.next.regression'
  | 'cli.run.next.noise'
  | 'cli.run.next.underpowered'
  | 'cli.run.next.solo'
  | 'cli.run.next.inspect'
  | 'cli.run.next.evidence'

  | 'cli.run.batch_verdict_header'
  | 'cli.run.codex_fallback_hint'
  | 'cli.run.codex_auth_hint'
  | 'cli.run.codex_model_hint'
  | 'cli.run.openai_api_auth_hint'
  | 'cli.run.openai_api_model_hint'
  | 'cli.run.anthropic_api_auth_hint'
  | 'cli.run.anthropic_api_model_hint';

export const runDict: Record<RunMessageKey, CliMessage> = {
  "cli.run.custom_executor_path": { zh: "无法读取自定义执行器。请将 --executor 指向存在且可执行的单个文件；不接受 \"node script.mjs\" 这类带参数的命令。脚本请添加 shebang 并设置执行权限，或用可执行包装脚本调用服务。路径相对于项目目录解析。", en: "Cannot read the custom executor. Point --executor to one existing executable file, not a command with arguments such as \"node script.mjs\". Add a shebang and execution permission, or use an executable wrapper. Relative paths resolve from the project directory." },
  "cli.run.summary.verdict": { zh: "评测结论：{verdict}", en: "Evaluation verdict: {verdict}" },
  "cli.run.summary.execution": { zh: "执行：{succeeded}/{planned} 成功，失败 {failed}，取消 {cancelled}，预算中止 {budgetCensored}，未开始 {notStarted}。", en: "Execution: {succeeded}/{planned} succeeded, {failed} failed, {cancelled} cancelled, {budgetCensored} budget-censored, {notStarted} not started." },
  "cli.run.summary.evaluation": { zh: "评分：{completed}/{planned} 完成，失败 {failed}，证据不可用 {sourceUnavailable}。", en: "Scoring: {completed}/{planned} completed, {failed} failed, {sourceUnavailable} source unavailable." },
  "cli.run.summary.state": { zh: "状态：运行 {run}；证据 {evidence}；结论 {conclusion}；门禁 {gate}。", en: "Status: run {run}; evidence {evidence}; conclusion {conclusion}; gate {gate}." },
  "cli.run.summary.reasons": { zh: "原因代码：{reasons}", en: "Reason codes: {reasons}" },
  "cli.run.summary.run": { zh: "本次运行：{runId}", en: "Run: {runId}" },
  "cli.run.next.progress": { zh: "下一步：复核用例代表性与报告告警，再进入自己的发布流程。", en: "Next: review sample representativeness and report warnings before entering your release process." },
  "cli.run.next.regression": { zh: "下一步：查看退步用例与评分证据，修复后用同一组用例复测。", en: "Next: inspect regressed cases and scoring evidence, fix the issue, and rerun the same cases." },
  "cli.run.next.noise": { zh: "下一步：当前证据无法确认差异；检查用例区分度和样本设计，再决定是否补充测量。", en: "Next: current evidence does not establish a difference. Check case sensitivity and sample design before adding measurements." },
  "cli.run.next.underpowered": { zh: "下一步：按预先声明的样本量要求补充用例，再重新评测；当前不能作为发布依据。", en: "Next: meet the predeclared sample-size requirement and rerun; this result is not release evidence." },
  "cli.run.next.solo": { zh: "下一步：添加对照版本，再判断改动是否有效。", en: "Next: add a control version to evaluate whether the change helps." },
  "cli.run.next.inspect": { zh: "下一步：查看报告中的具体原因和门禁条件，处理后复测。", en: "Next: inspect the report reasons and gate conditions, address them, and rerun." },
  "cli.run.next.evidence": { zh: "下一步：先检查失败调用与缺失证据，恢复有效评测后再比较分数。", en: "Next: inspect failed calls and missing evidence before comparing scores." },

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
