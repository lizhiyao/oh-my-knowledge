import { Errors } from '@oclif/core';
import { getCodexModelSuggestion } from './codex-model-hint.js';
import { executorFamily, isRemovedBuiltinExecutor } from '../../executors/core/registry.js';

export interface RuntimeResolutionOptions {
  env?: NodeJS.ProcessEnv;
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

export function isCodexExecutor(executor: string): boolean {
  return executorFamily(executor) === 'codex';
}

export function resolveCliExecutor(
  explicitExecutor?: string,
  options: RuntimeResolutionOptions = {},
): string {
  const env = options.env ?? process.env;
  const executor = nonEmpty(explicitExecutor) ?? nonEmpty(env.OMK_EXECUTOR) ?? 'codex';
  if (isRemovedBuiltinExecutor(executor)) {
    throw new Errors.CLIError(options.lang === 'en'
      ? `Built-in executor ${executor} has been removed. Select codex, codex-sdk, openai-api or an executable adapter path.`
      : `内置执行器「${executor}」已移除。请选择 codex、codex-sdk、openai-api 或自定义执行器文件路径。`, { exit: 2 });
  }
  return executor;
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

  if (!isCodexExecutor(executor)) {
    throw new Errors.CLIError(options.lang === 'en'
      ? `Executor ${executor} needs an explicit model. Pass --model <model> or set OMK_MODEL.`
      : `执行器 ${executor} 需要明确模型。请用 --model <model> 或设置 OMK_MODEL。`, { exit: 2 });
  }

  const suggestion = getCodexModelSuggestion(env);
  if (suggestion.fromConfig) return suggestion.model;

  const lang = options.lang ?? 'zh';
  throw new Errors.CLIError(lang === 'zh'
    ? `Codex 执行器需要明确模型。请用 --model <model>、设置 OMK_MODEL，或在 ${suggestion.configPath} 配置 model 与 profile。`
    : `The Codex executor needs an explicit model. Pass --model <model>, set OMK_MODEL, or configure model and profile in ${suggestion.configPath}.`, { exit: 2 });
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
    judgeModel: model,
  };
}

export function envJudgeModels(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return nonEmpty(env.OMK_JUDGE_MODELS);
}
