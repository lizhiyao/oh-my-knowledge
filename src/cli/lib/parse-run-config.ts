/**
 * CLI 前置工作：加载文件、发现路径、校验物理身份并选择运行时默认值。
 * 执行参数由 Workflow 的 parseCliEvaluationRequest 统一解释。
 */

import { resolve } from 'node:path';
import { loadEvalConfig } from '../../eval-workflows/inputs/eval-config.js';
import type { EvalConfig } from '../../eval-workflows/inputs/contracts/config.js';
import type { JudgeConfig } from '../../eval-workflows/instruments/contracts/config.js';
import { parseJudgeModelsArgOrExit } from './parse-run-config/judge-models.js';
import { discoverSamplesPath } from './parse-run-config/samples-discovery.js';
import { resolveVariantSpecs } from './parse-run-config/variant-resolution.js';
import {
  envJudgeModels,
  resolveRuntimeSelection,
  type RuntimeResolutionOptions,
} from './runtime-defaults.js';

export { parseJudgeModelsArg, parseJudgeModelsArgOrExit } from './parse-run-config/judge-models.js';

export interface RunConfig {
  samplesPath: string;
  skillDir: string;
  model: string;
  noJudge: boolean;
  executorName: string;
  judgeModels: JudgeConfig[];
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ParseRunConfigResult {
  values: Record<string, string | boolean | undefined>;
  config: RunConfig;
  /** 已加载的 eval.yaml，交给 Workflow 解析参数优先级与约束。 */
  evalConfig: EvalConfig | null;
}

/** 接收 oclif 已解析的 typed flags，不再次解析 argv。 */
export function parseRunConfig(
  values: Record<string, unknown>,
  runtimeOptions: RuntimeResolutionOptions = {},
): ParseRunConfigResult {
  if (values.variants !== undefined) {
    throw new Error(
      `--variants 已在 v0.16 废除，请改用 --control <expr> 与 --treatment <v1,v2,...>\n`
      + `  迁移示例：--variants baseline,my-skill  →  --control baseline --treatment my-skill\n`
      + `  复杂场景可用 --config eval.yaml（参见 docs/zh/specs/terminology-spec.md）`,
    );
  }
  // 1) Load --config (if provided). All subsequent fields fall back to it when CLI is silent.
  const evalConfig: EvalConfig | null = values.config
    ? loadEvalConfig(values.config as string)
    : null;

  const skillDir: string = resolve((values['skill-dir'] as string | undefined) ?? 'skills');

  // 2) Resolve samples path: CLI > config > single-treatment skill-local discovery > cwd project default.
  // Skill-local discovery only fires when exactly one --treatment is given, so omk knows
  // which skill's private canonical file to use. Explicit --samples / eval.yaml values may
  // still point at a custom JSON / YAML file or a split directory.
  const cliSamples = values.samples as string | undefined;
  let samplesFile: string;
  if (cliSamples) {
    samplesFile = cliSamples;
  } else if (evalConfig?.samples) {
    samplesFile = evalConfig.samples;  // already resolved against config file dir
  } else {
    samplesFile = discoverSamplesPath(values, skillDir, runtimeOptions.lang ?? 'zh');
  }

  // 3) Resolve variantSpecs: CLI > config > batch > error。dedup 在 helper 里。
  resolveVariantSpecs(values, evalConfig, skillDir);

  // 4) Select runtime defaults and connectivity failure hints.
  const runtime = resolveRuntimeSelection({
    executor: (values.executor as string | undefined) ?? evalConfig?.executor,
    model: (values.model as string | undefined) ?? evalConfig?.model,
  }, runtimeOptions);
  const executorName = runtime.executor;
  const model = runtime.model;

  // judgeModels: unified judge config. Parse --judge-models (CLI) or evalConfig.judgeModels (yaml).
  // 1 entry = single judge, ≥ 2 entries = ensemble. Format `executor:model[,executor:model]`.
  // 出口 RunConfig.judgeModels 保证非空。Codex 默认沿用任务模型，避免把 Claude 的
  // `haiku` alias 误传给 Codex。
  const cliJudgesRaw = values['judge-models'] as string | undefined;
  const parsedJudges = cliJudgesRaw !== undefined ? parseJudgeModelsArgOrExit(cliJudgesRaw) : undefined;
  const envJudgesRaw = envJudgeModels(runtimeOptions.env);
  const parsedEnvJudges = envJudgesRaw !== undefined ? parseJudgeModelsArgOrExit(envJudgesRaw) : undefined;
  const judgeModels: JudgeConfig[] = parsedJudges
    ?? evalConfig?.judgeModels
    ?? parsedEnvJudges
    ?? [{ executor: executorName, model: runtime.judgeModel }];
  const noJudge = (values['no-judge'] as boolean | undefined) ?? evalConfig?.noJudge ?? false;
  // effort:CLI > evalConfig > 默认 'low'。校验合法值,不合法就 throw(early surface error)。
  const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  const effortRaw = (values.effort as string | undefined) ?? evalConfig?.effort ?? 'low';
  if (!VALID_EFFORTS.has(effortRaw)) {
    throw new Error(`--effort must be one of low/medium/high/xhigh/max (got "${effortRaw}")`);
  }
  const effort = effortRaw as 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  return {
    values: values as Record<string, string | boolean | undefined>,
    config: {
      samplesPath: resolve(samplesFile),
      skillDir,
      model,
      noJudge,
      executorName,
      judgeModels,
      effort,
    },
    evalConfig,
  };
}
