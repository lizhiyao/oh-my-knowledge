import { tCli, type CliLang } from './i18n.js';

const CLAUDE_SAMPLE_EXECUTORS = new Set(['claude', 'claude-sdk']);
const CODEX_SAMPLE_EXECUTORS = new Set(['codex', 'codex-sdk']);
const OPENAI_API_SAMPLE_EXECUTORS = new Set(['openai-api']);
const ANTHROPIC_API_SAMPLE_EXECUTORS = new Set(['anthropic-api']);

function looksLikeConnectivityFailure(message: string): boolean {
  return /auth|login|credential|API[_ ]?KEY|BASE_URL|API error|ENOENT|not found|ECONN|ENOTFOUND|ETIMEDOUT|timeout|timed out|401|403|404/i.test(message);
}

export function formatSampleGenerationFailureHint(
  message: string,
  executorName: string | undefined,
  lang: CliLang,
): string {
  const executor = executorName ?? 'claude';
  if (!looksLikeConnectivityFailure(message)) return '';

  if (CLAUDE_SAMPLE_EXECUTORS.has(executor)) {
    return tCli('cli.gen.claude_auth_hint', lang, {
      codexFlags: '--executor codex --model <codex-model>',
      openaiFlags: '--executor openai-api --model <openai-model>',
    });
  }
  if (CODEX_SAMPLE_EXECUTORS.has(executor)) {
    return tCli('cli.gen.codex_auth_hint', lang, {
      claudeFlags: '--executor claude --model sonnet',
      openaiFlags: '--executor openai-api --model <openai-model>',
    });
  }
  if (OPENAI_API_SAMPLE_EXECUTORS.has(executor)) {
    return tCli('cli.gen.openai_api_auth_hint', lang, {
      claudeFlags: '--executor claude --model sonnet',
      codexFlags: '--executor codex --model <codex-model>',
    });
  }
  if (ANTHROPIC_API_SAMPLE_EXECUTORS.has(executor)) {
    return tCli('cli.gen.anthropic_api_auth_hint', lang, {
      claudeFlags: '--executor claude --model sonnet',
    });
  }
  return '';
}
