import { tCli, type CliLang } from './i18n.js';
import { codexExecutorFlags, codexModelFlagValue, codexModelHint } from './codex-model-hint.js';
import { looksLikeLlmSetupFailure, looksLikeModelUnavailableFailure } from './llm-failure-classifier.js';

const CLAUDE_SAMPLE_EXECUTORS = new Set(['claude', 'claude-sdk']);
const CODEX_SAMPLE_EXECUTORS = new Set(['codex', 'codex-sdk']);
const OPENAI_API_SAMPLE_EXECUTORS = new Set(['openai-api']);
const ANTHROPIC_API_SAMPLE_EXECUTORS = new Set(['anthropic-api']);

export function formatSampleGenerationFailureHint(
  message: string,
  executorName: string | undefined,
  lang: CliLang,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const executor = executorName?.trim();
  if (!executor) return '';
  if (!looksLikeLlmSetupFailure(message)) return '';

  if (CLAUDE_SAMPLE_EXECUTORS.has(executor)) {
    return tCli('cli.gen.claude_auth_hint', lang, {
      codexFlags: codexExecutorFlags(env),
      codexModelHint: codexModelHint(lang, env),
      openaiFlags: '--executor openai-api --model <openai-model>',
    });
  }
  if (CODEX_SAMPLE_EXECUTORS.has(executor)) {
    if (looksLikeModelUnavailableFailure(message)) {
      return tCli('cli.gen.codex_model_hint', lang, {
        codexFlags: codexExecutorFlags(env),
        codexExec: `codex exec -m ${codexModelFlagValue(env)} "hi"`,
        claudeFlags: '--executor claude --model sonnet',
        openaiFlags: '--executor openai-api --model <openai-model>',
        codexModelHint: codexModelHint(lang, env),
      });
    }
    return tCli('cli.gen.codex_auth_hint', lang, {
      claudeFlags: '--executor claude --model sonnet',
      openaiFlags: '--executor openai-api --model <openai-model>',
    });
  }
  if (OPENAI_API_SAMPLE_EXECUTORS.has(executor)) {
    if (looksLikeModelUnavailableFailure(message)) {
      return tCli('cli.gen.openai_api_model_hint', lang, {
        claudeFlags: '--executor claude --model sonnet',
        codexFlags: codexExecutorFlags(env),
        codexModelHint: codexModelHint(lang, env),
      });
    }
    return tCli('cli.gen.openai_api_auth_hint', lang, {
      claudeFlags: '--executor claude --model sonnet',
      codexFlags: codexExecutorFlags(env),
      codexModelHint: codexModelHint(lang, env),
    });
  }
  if (ANTHROPIC_API_SAMPLE_EXECUTORS.has(executor)) {
    if (looksLikeModelUnavailableFailure(message)) {
      return tCli('cli.gen.anthropic_api_model_hint', lang, {
        claudeFlags: '--executor claude --model sonnet',
      });
    }
    return tCli('cli.gen.anthropic_api_auth_hint', lang, {
      claudeFlags: '--executor claude --model sonnet',
    });
  }
  return '';
}
