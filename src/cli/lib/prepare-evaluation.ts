import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEvalConfig } from '../../eval-workflows/inputs/eval-config.js';
import type { EvalConfig } from '../../eval-workflows/inputs/contracts/config.js';
import {
  parseCliEvaluationRequest,
  type CliEvaluationParseInput,
} from '../../eval-workflows/hosts/application.js';
import { globalLayout, projectLayout } from '../../evidence/storage/layout.js';
import { captureNodeCliEvaluationEnvironment } from './evaluation-composition.js';
import { discoverSamplesPath } from './parse-run-config/samples-discovery.js';
import { envJudgeModels, resolveRuntimeSelection, type RuntimeResolutionOptions } from './runtime-defaults.js';

export interface PrepareCliEvaluationOptions extends RuntimeResolutionOptions {
  projectRoot?: string;
  evalConfig?: EvalConfig;
}

/** Capture host facts once; Workflow owns the normalized evaluation request. */
export function prepareCliEvaluation(
  flags: Readonly<Record<string, unknown>>,
  options: PrepareCliEvaluationOptions = {},
) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const environment = captureNodeCliEvaluationEnvironment(options.env);
  const evalConfig = flags.config === undefined
    ? options.evalConfig
    : loadEvalConfig(resolve(projectRoot, flags.config as string));
  const skillDirectory = resolve(projectRoot, (flags['skill-dir'] as string | undefined) ?? 'skills');
  const samples = flags.samples !== undefined || evalConfig?.samples !== undefined
    ? 'eval-samples.json'
    : discoverSamplesPath(flags, skillDirectory, options.lang ?? 'zh', projectRoot);
  // Model inference needs the chosen executor, but the parser retains source precedence.
  const runtime = resolveRuntimeSelection({
    executor: (flags.executor as string | undefined) ?? evalConfig?.executor,
    model: (flags.model as string | undefined) ?? evalConfig?.model,
  }, { ...options, env: environment.environment });
  const projectMcpConfig = join(projectRoot, '.mcp.json');
  const parseInput: CliEvaluationParseInput = {
    explicitCliFlags: { ...flags },
    ...(evalConfig === undefined ? {} : { evalConfig }),
    defaults: {
      samplesLocator: resolve(projectRoot, samples),
      skillDirectoryLocator: skillDirectory,
      ...(existsSync(projectMcpConfig) ? { mcpConfigLocator: projectMcpConfig } : {}),
      targetRuntime: { executorId: runtime.executor, model: runtime.model, effort: 'low' },
      judgeMembers: [{ executorId: runtime.executor, model: runtime.judgeModel }],
      judgeModels: envJudgeModels(environment.environment),
      presentation: {
        projectOutputDirectoryLocator: projectLayout(projectRoot).evalDir,
        globalOutputDirectoryLocator: globalLayout(environment.environment.OMK_HOME).evalDir,
        language: options.lang ?? 'zh',
        languageDefaultSource: 'environment-selection',
      },
    },
  };
  return { request: parseCliEvaluationRequest(parseInput), parseInput, projectRoot, environment };
}

export type PreparedCliEvaluation = ReturnType<typeof prepareCliEvaluation>;
