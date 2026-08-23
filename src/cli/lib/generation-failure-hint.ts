import { tCli, type CliLang } from './i18n.js';
import { codexExecutorFlags, codexModelFlagValue, codexModelHint } from './codex-model-hint.js';
import { looksLikeLlmSetupFailure, looksLikeModelUnavailableFailure } from './llm-failure-classifier.js';
import { executorFamily } from '../../executors/core/registry.js';

export function formatSampleGenerationFailureHint(
  message: string,
  executorName: string | undefined,
  lang: CliLang,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const executor = executorName?.trim();
  if (!executor) return '';
  if (!looksLikeLlmSetupFailure(message)) return '';
  const family = executorFamily(executor);

  if (family === 'claude') {
    return tCli('cli.gen.claude_auth_hint', lang, {
      codexFlags: codexExecutorFlags(env),
      codexModelHint: codexModelHint(lang, env),
      openaiFlags: '--executor openai-api --model <openai-model>',
    });
  }
  if (family === 'codex') {
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
  if (family === 'openai-api') {
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
  if (family === 'anthropic-api') {
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
