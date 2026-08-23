import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { getCodexModelSuggestion } from './codex-model-hint.js';
import { DEFAULT_MODEL, JUDGE_MODEL } from '../../executors/core/defaults.js';
import { executorFamily } from '../../executors/core/registry.js';

export interface RuntimeResolutionOptions {
  env?: NodeJS.ProcessEnv;
  commandExists?: (command: string, env: NodeJS.ProcessEnv) => boolean;
  lang?: 'zh' | 'en';
}

export interface RuntimeSelection {
  executor: string;
  model: string;
  judgeModel: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function commandExistsOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathEntries = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  return pathEntries.some((entry) => extensions.some((extension) => {
    try {
      accessSync(join(entry, `${command}${extension}`), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

export function isCodexHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    nonEmpty(env.CODEX_THREAD_ID)
    || nonEmpty(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE)
    || nonEmpty(env.CODEX_CI),
  );
}

export function isCodexExecutor(executor: string): boolean {
  return executorFamily(executor) === 'codex';
}

export function resolveCliExecutor(
  explicitExecutor?: string,
  options: RuntimeResolutionOptions = {},
): string {
  const env = options.env ?? process.env;
  const explicit = nonEmpty(explicitExecutor);
  if (explicit) return explicit;

  const envExecutor = nonEmpty(env.OMK_EXECUTOR);
  if (envExecutor) return envExecutor;

  if (isCodexHost(env)) return 'codex';

  const commandExists = options.commandExists ?? commandExistsOnPath;
  if (commandExists('codex', env) && !commandExists('claude', env)) return 'codex';
  return 'claude';
}

export function resolveCliModel(
  executor: string,
  explicitModel?: string,
  options: RuntimeResolutionOptions = {},
): string {
  const env = options.env ?? process.env;
  const explicit = nonEmpty(explicitModel);
  if (explicit) return explicit;

  const envModel = nonEmpty(env.OMK_MODEL);
  if (envModel) return envModel;

  if (!isCodexExecutor(executor)) return DEFAULT_MODEL;

  const suggestion = getCodexModelSuggestion(env);
  if (suggestion.fromConfig) return suggestion.model;

  const lang = options.lang ?? 'zh';
  throw new Error(lang === 'zh'
    ? `Codex 执行器需要明确模型。请用 --model <model>、设置 OMK_MODEL，或在 ${suggestion.configPath} 配置顶层 model。`
    : `The Codex executor needs an explicit model. Pass --model <model>, set OMK_MODEL, or configure a top-level model in ${suggestion.configPath}.`);
}

export function defaultJudgeModel(executor: string, taskModel: string): string {
  return isCodexExecutor(executor) ? taskModel : JUDGE_MODEL;
}

export function resolveRuntimeSelection(
  input: { executor?: string; model?: string },
  options: RuntimeResolutionOptions = {},
): RuntimeSelection {
  const executor = resolveCliExecutor(input.executor, options);
  const model = resolveCliModel(executor, input.model, options);
  return {
    executor,
    model,
    judgeModel: defaultJudgeModel(executor, model),
  };
}

export function envJudgeModels(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return nonEmpty(env.OMK_JUDGE_MODELS);
}
