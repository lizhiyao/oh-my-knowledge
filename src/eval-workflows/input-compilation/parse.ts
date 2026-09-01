import type { EvalConfig, EvalConfigVariant } from '../../inputs/contracts/config.js';
import type { JudgeConfig } from '../../grading/contracts/config.js';
import { deepFreezeCanonicalJson } from '../../evaluation-core/contracts/index.js';
import { DEFAULT_BOOTSTRAP_SAMPLES } from '../../shared/statistics/bootstrap.js';
import { DEFAULT_EVALUATION_TIMEOUT_MS } from '../evaluation-defaults.js';
import { CliEvaluationInputError } from './error.js';
import {
  CLI_EVALUATION_REQUEST_SCHEMA_VERSION,
  type CliEvaluationFieldSource,
  type CliEvaluationJudgeRequest,
  type CliEvaluationRequest,
  type CliEvaluationRequestValues,
  type CliEvaluationVariantRequest,
} from './types.js';

export interface CliEvaluationParseDefaults {
  readonly samplesLocator: string;
  readonly skillDirectoryLocator: string;
  readonly targetRuntime: CliEvaluationRequestValues['targetRuntime'];
  readonly judgeMembers: readonly CliEvaluationJudgeRequest[];
  readonly presentation: {
    readonly projectOutputDirectoryLocator: string;
    readonly globalOutputDirectoryLocator: string;
    readonly language: 'zh' | 'en';
    readonly languageDefaultSource: 'environment-selection' | 'derived';
  };
}

export interface CliEvaluationParseInput {
  /** Only explicitly supplied flags. Oclif-injected defaults must not be copied here. */
  readonly explicitCliFlags: Readonly<Record<string, unknown>>;
  /** Already syntax-validated eval.yaml data; loading and path resolution remain outside Parse. */
  readonly evalConfig?: Readonly<EvalConfig>;
  /** Host-selected defaults are explicit inputs, never read from process.env here. */
  readonly defaults: CliEvaluationParseDefaults;
}

interface PickInput<Value> {
  normalizedField: string;
  cliKey?: string;
  cliValue?: Value;
  configKey?: string;
  configValue?: Value;
  defaultValue?: Value;
  defaultSource?: 'documented' | 'environment-selection' | 'derived';
}

function invalid(fieldPath: string, message: string): never {
  throw new CliEvaluationInputError({ code: 'CLI_INPUT_INVALID', fieldPath, message });
}

function nonEmptyString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    return invalid(fieldPath, `输入字段「${fieldPath}」必须是非空字符串。`);
  }
  return value.trim();
}

function booleanValue(value: unknown, fieldPath: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    return invalid(fieldPath, `输入字段「${fieldPath}」必须是 boolean。`);
  }
  return value;
}

function numericValue(
  value: unknown,
  fieldPath: string,
  options: { integer?: boolean; min?: number; max?: number; exclusive?: boolean } = {},
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  const belowMin = options.min !== undefined
    && (options.exclusive ? parsed <= options.min : parsed < options.min);
  const aboveMax = options.max !== undefined
    && (options.exclusive ? parsed >= options.max : parsed > options.max);
  if (!Number.isFinite(parsed) || (options.integer === true && !Number.isInteger(parsed))
      || belowMin || aboveMax) {
    return invalid(fieldPath, `输入字段「${fieldPath}」的数值不合法。`);
  }
  return parsed;
}

function parseJudgeModels(value: string): CliEvaluationJudgeRequest[] {
  const members = value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator === entry.length - 1) {
      return invalid('judge-models', '评委配置必须使用 executor:model 格式。');
    }
    return { executorId: entry.slice(0, separator), model: entry.slice(separator + 1) };
  });
  if (members.length === 0) invalid('judge-models', '评委配置不得为空。');
  const identities = members.map((member) => `${member.executorId}:${member.model}`);
  if (new Set(identities).size !== identities.length) {
    invalid('judge-models', '评委配置不得包含重复的 executor:model。');
  }
  return members;
}

function configJudgeModels(value: readonly JudgeConfig[]): CliEvaluationJudgeRequest[] {
  return value.map((member) => ({ executorId: member.executor, model: member.model }));
}

function expressionTargetId(expression: string): string {
  const normalized = expression.replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  const leaf = parts.at(-1) ?? normalized;
  const candidate = leaf === 'SKILL.md' ? parts.at(-2) ?? leaf : leaf.replace(/\.md$/i, '');
  return candidate || expression;
}

function variantFromConfig(variant: Readonly<EvalConfigVariant>): CliEvaluationVariantRequest {
  const artifactSource = variant.git === undefined
    ? { artifactSourceKind: 'expression' as const, expression: variant.artifact as string }
    : {
        artifactSourceKind: 'remote-git' as const,
        url: variant.git.url,
        ...(variant.git.ref === undefined ? {} : { ref: variant.git.ref }),
        spec: variant.git.spec,
      };
  return {
    targetId: variant.name,
    experimentRole: variant.role,
    artifactSource,
    ...(variant.cwd === undefined ? {} : { workspaceLocator: variant.cwd }),
    ...(variant.allowedSkills === undefined ? {} : { allowedSkills: [...variant.allowedSkills] }),
  };
}

function cliVariants(flags: Readonly<Record<string, unknown>>): CliEvaluationVariantRequest[] | undefined {
  const control = nonEmptyString(flags.control, 'control');
  const treatmentRaw = nonEmptyString(flags.treatment, 'treatment');
  const controlCwd = nonEmptyString(flags['control-cwd'], 'control-cwd');
  const treatmentCwdRaw = nonEmptyString(flags['treatment-cwd'], 'treatment-cwd');
  if (control === undefined && treatmentRaw === undefined) {
    if (controlCwd !== undefined || treatmentCwdRaw !== undefined) {
      invalid('variants', 'control-cwd／treatment-cwd 必须与 CLI variant 一起使用。');
    }
    return undefined;
  }
  if (control === undefined || treatmentRaw === undefined) {
    invalid('variants', '非 batch CLI evaluation 必须同时声明 control 和 treatment。');
  }
  const treatments = treatmentRaw.split(',').map((value) => value.trim()).filter(Boolean);
  if (treatments.length === 0) invalid('treatment', '至少需要一个 treatment。');
  const treatmentCwds = treatmentCwdRaw === undefined
    ? []
    : treatmentCwdRaw.split(',').map((value) => value.trim());
  if (treatmentCwds.length > 0 && treatmentCwds.length !== treatments.length) {
    invalid('treatment-cwd', 'treatment-cwd 必须与 treatment 按序对齐。');
  }
  const variants: CliEvaluationVariantRequest[] = [{
    targetId: expressionTargetId(control),
    experimentRole: 'control',
    artifactSource: { artifactSourceKind: 'expression', expression: control },
    ...(controlCwd === undefined ? {} : { workspaceLocator: controlCwd }),
  }, ...treatments.map((expression, index): CliEvaluationVariantRequest => ({
    targetId: expressionTargetId(expression),
    experimentRole: 'treatment',
    artifactSource: { artifactSourceKind: 'expression', expression },
    ...(treatmentCwds[index] ? { workspaceLocator: treatmentCwds[index] } : {}),
  }))];
  const targetIds = variants.map((variant) => variant.targetId);
  if (new Set(targetIds).size !== targetIds.length) {
    invalid('variants', 'CLI variant 派生出重复 targetId，请改用 eval.yaml 显式命名。');
  }
  return variants;
}

export function parseCliEvaluationRequest(
  input: Readonly<CliEvaluationParseInput>,
): CliEvaluationRequest {
  const flags = input.explicitCliFlags;
  const config = input.evalConfig;
  const fieldSources: CliEvaluationFieldSource[] = [];
  const pick = <Value>(candidate: PickInput<Value>): Value | undefined => {
    if (candidate.cliValue !== undefined && candidate.cliKey !== undefined) {
      fieldSources.push({
        normalizedField: candidate.normalizedField,
        sourceKind: 'cli-flag',
        sourceKey: candidate.cliKey,
      });
      return candidate.cliValue;
    }
    if (candidate.configValue !== undefined && candidate.configKey !== undefined) {
      fieldSources.push({
        normalizedField: candidate.normalizedField,
        sourceKind: 'eval-config',
        sourceKey: candidate.configKey,
      });
      return candidate.configValue;
    }
    if (candidate.defaultSource !== undefined && candidate.defaultValue !== undefined) {
      fieldSources.push(candidate.defaultSource === 'documented'
        ? {
            normalizedField: candidate.normalizedField,
            sourceKind: 'documented-default',
            sourceKey: candidate.normalizedField,
            defaultSource: 'documented',
          }
        : {
            normalizedField: candidate.normalizedField,
            sourceKind: 'host-default',
            sourceKey: candidate.normalizedField,
            defaultSource: candidate.defaultSource,
          });
    }
    return candidate.defaultValue;
  };

  const parsedCliVariants = cliVariants(flags);
  const batch = pick({
    normalizedField: 'values.orchestration.batch',
    cliKey: 'batch', cliValue: booleanValue(flags.batch, 'batch'),
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  const variants = parsedCliVariants
    ?? config?.variants.map(variantFromConfig)
    ?? (batch ? [] : invalid('variants', '必须通过 CLI 或 eval.yaml 声明 variant。'));
  fieldSources.push({
    normalizedField: 'values.variants',
    sourceKind: parsedCliVariants !== undefined || config === undefined ? 'cli-flag' : 'eval-config',
    sourceKey: parsedCliVariants !== undefined ? 'control/treatment' : config === undefined ? 'batch' : 'variants',
  });

  const executorId = pick({
    normalizedField: 'values.targetRuntime.executorId',
    cliKey: 'executor', cliValue: nonEmptyString(flags.executor, 'executor'),
    configKey: 'executor', configValue: config?.executor,
    defaultValue: input.defaults.targetRuntime.executorId,
    defaultSource: 'environment-selection',
  }) as string;
  const model = pick({
    normalizedField: 'values.targetRuntime.model',
    cliKey: 'model', cliValue: nonEmptyString(flags.model, 'model'),
    configKey: 'model', configValue: config?.model,
    defaultValue: input.defaults.targetRuntime.model,
    defaultSource: 'environment-selection',
  }) as string;
  const effort = pick({
    normalizedField: 'values.targetRuntime.effort',
    cliKey: 'effort', cliValue: nonEmptyString(flags.effort, 'effort'),
    configKey: 'effort', configValue: config?.effort,
    defaultValue: 'low', defaultSource: 'documented',
  });
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort as string)) {
    invalid('effort', 'effort 不受支持。');
  }

  const noJudge = pick({
    normalizedField: 'values.judges.enabled',
    cliKey: 'no-judge', cliValue: booleanValue(flags['no-judge'], 'no-judge'),
    configKey: 'noJudge', configValue: config?.noJudge,
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  let judgeMembers: readonly CliEvaluationJudgeRequest[] = [];
  if (!noJudge) {
    const cliJudgeModels = nonEmptyString(flags['judge-models'], 'judge-models');
    judgeMembers = pick({
      normalizedField: 'values.judges.members',
      cliKey: 'judge-models', cliValue: cliJudgeModels === undefined
        ? undefined
        : parseJudgeModels(cliJudgeModels),
      configKey: 'judgeModels', configValue: config?.judgeModels === undefined
        ? undefined
        : configJudgeModels(config.judgeModels),
      defaultValue: input.defaults.judgeMembers,
      defaultSource: 'environment-selection',
    }) as readonly CliEvaluationJudgeRequest[];
    if (judgeMembers.length === 0) invalid('judges.members', '启用评委时必须解析出至少一个评委。');
  }

  const strictFlag = booleanValue(flags['strict-baseline'], 'strict-baseline');
  const noStrictFlag = booleanValue(flags['no-strict-baseline'], 'no-strict-baseline');
  if (strictFlag === true && noStrictFlag === true) {
    throw new CliEvaluationInputError({
      code: 'CLI_INPUT_BASELINE_ISOLATION_CONFLICT',
      fieldPath: 'strict-baseline',
      message: 'strict-baseline 与 no-strict-baseline 不得同时使用。',
    });
  }
  const baselineIsolation = pick({
    normalizedField: 'values.measurement.baselineIsolation',
    cliKey: noStrictFlag === true ? 'no-strict-baseline' : 'strict-baseline',
    cliValue: noStrictFlag === true ? false : strictFlag,
    configKey: 'strictBaseline', configValue: config?.strictBaseline,
    defaultValue: true, defaultSource: 'documented',
  }) as boolean;

  const timeoutSeconds = numericValue(flags.timeout, 'timeout', { min: 0, exclusive: true });
  const executionTimeoutMs = pick({
    normalizedField: 'values.measurement.timeoutMs',
    cliKey: 'timeout', cliValue: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
    configKey: 'timeoutMs', configValue: numericValue(
      config?.timeoutMs, 'timeoutMs', { integer: true, min: 1 },
    ),
    defaultValue: DEFAULT_EVALUATION_TIMEOUT_MS, defaultSource: 'documented',
  }) as number;
  if (!Number.isInteger(executionTimeoutMs) || executionTimeoutMs < 1) {
    invalid('timeoutMs', 'timeoutMs 必须是正整数。');
  }

  const budgetTotal = pick({
    normalizedField: 'values.measurement.budget.totalProviderCostUSD',
    cliKey: 'budget-usd', cliValue: numericValue(
      flags['budget-usd'], 'budget-usd', { min: 0, exclusive: true },
    ),
    configKey: 'budget.totalUSD', configValue: numericValue(
      config?.budget?.totalUSD, 'budget.totalUSD', { min: 0, exclusive: true },
    ),
  });
  const budgetCoordinateCost = pick({
    normalizedField: 'values.measurement.budget.perCoordinateProviderCostUSD',
    cliKey: 'budget-per-sample-usd',
    cliValue: numericValue(flags['budget-per-sample-usd'], 'budget-per-sample-usd', {
      min: 0, exclusive: true,
    }),
    configKey: 'budget.perSampleUSD', configValue: numericValue(
      config?.budget?.perSampleUSD, 'budget.perSampleUSD', { min: 0, exclusive: true },
    ),
  });
  const budgetCoordinateDuration = pick({
    normalizedField: 'values.measurement.budget.perCoordinateActiveDurationMs',
    cliKey: 'budget-per-sample-ms',
    cliValue: numericValue(flags['budget-per-sample-ms'], 'budget-per-sample-ms', {
      integer: true, min: 0, exclusive: true,
    }),
    configKey: 'budget.perSampleMs', configValue: numericValue(
      config?.budget?.perSampleMs, 'budget.perSampleMs', {
        integer: true, min: 0, exclusive: true,
      },
    ),
  });
  const hasBudget = budgetTotal !== undefined
    || budgetCoordinateCost !== undefined
    || budgetCoordinateDuration !== undefined;

  const repeatCount = pick({
    normalizedField: 'values.orchestration.repeatCount',
    cliKey: 'repeat', cliValue: numericValue(flags.repeat, 'repeat', { integer: true, min: 1 }),
    configKey: 'repeat', configValue: numericValue(
      config?.repeat, 'repeat', { integer: true, min: 1 },
    ),
    defaultValue: 1, defaultSource: 'documented',
  }) as number;
  const judgeReplicateCount = pick({
    normalizedField: 'values.judges.replicateCount',
    cliKey: 'judge-repeat',
    cliValue: numericValue(flags['judge-repeat'], 'judge-repeat', { integer: true, min: 1 }),
    configKey: 'judgeRepeat', configValue: numericValue(
      config?.judgeRepeat, 'judgeRepeat', { integer: true, min: 1 },
    ),
    defaultValue: 1, defaultSource: 'documented',
  }) as number;
  const holdoutRatio = pick({
    normalizedField: 'values.measurement.holdoutRatio',
    cliKey: 'holdout-ratio',
    cliValue: numericValue(flags['holdout-ratio'], 'holdout-ratio', {
      min: 0, max: 1, exclusive: true,
    }),
    configKey: 'holdoutRatio', configValue: numericValue(
      config?.holdoutRatio, 'holdoutRatio', { min: 0, max: 1, exclusive: true },
    ),
  });
  const bootstrapEnabled = pick({
    normalizedField: 'values.measurement.bootstrap.enabled',
    cliKey: 'bootstrap', cliValue: booleanValue(flags.bootstrap, 'bootstrap'),
    configKey: 'bootstrap', configValue: config?.bootstrap,
    defaultValue: true, defaultSource: 'documented',
  }) as boolean;
  const bootstrapResamples = pick({
    normalizedField: 'values.measurement.bootstrap.resamples',
    cliKey: 'bootstrap-samples',
    cliValue: numericValue(flags['bootstrap-samples'], 'bootstrap-samples', { integer: true, min: 100 }),
    configKey: 'bootstrapSamples', configValue: numericValue(
      config?.bootstrapSamples, 'bootstrapSamples', { integer: true, min: 100 },
    ),
    defaultValue: DEFAULT_BOOTSTRAP_SAMPLES, defaultSource: 'documented',
  }) as number;

  const noDebiasLength = booleanValue(flags['no-debias-length'], 'no-debias-length');
  const lengthDebias = pick({
    normalizedField: 'values.judges.lengthDebias',
    cliKey: 'no-debias-length', cliValue: noDebiasLength === undefined ? undefined : !noDebiasLength,
    configKey: 'lengthDebias', configValue: config?.lengthDebias,
    defaultValue: true, defaultSource: 'documented',
  }) as boolean;

  const globalOutput = pick({
    normalizedField: 'values.presentation.indexScope',
    cliKey: 'global', cliValue: booleanValue(flags.global, 'global'),
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  const explicitOutput = nonEmptyString(flags['output-dir'], 'output-dir');
  const outputDirectoryLocator = explicitOutput
    ?? (globalOutput
      ? input.defaults.presentation.globalOutputDirectoryLocator
      : input.defaults.presentation.projectOutputDirectoryLocator);
  fieldSources.push(explicitOutput !== undefined
    ? { normalizedField: 'values.presentation.outputDirectoryLocator', sourceKind: 'cli-flag', sourceKey: 'output-dir' }
    : globalOutput
      ? { normalizedField: 'values.presentation.outputDirectoryLocator', sourceKind: 'cli-flag', sourceKey: 'global' }
      : {
          normalizedField: 'values.presentation.outputDirectoryLocator',
          sourceKind: 'host-default', sourceKey: 'outputDirectoryLocator', defaultSource: 'derived',
        });
  const explicitLanguage = nonEmptyString(flags.lang, 'lang');
  const language = explicitLanguage ?? input.defaults.presentation.language;
  if (language !== 'zh' && language !== 'en') invalid('lang', 'lang 必须是 zh 或 en。');
  fieldSources.push(explicitLanguage === undefined
    ? {
        normalizedField: 'values.presentation.language', sourceKind: 'host-default',
        sourceKey: 'language', defaultSource: input.defaults.presentation.languageDefaultSource,
      }
    : { normalizedField: 'values.presentation.language', sourceKind: 'cli-flag', sourceKey: 'lang' });

  const noServe = pick({
    normalizedField: 'values.presentation.serve',
    cliKey: 'no-serve', cliValue: booleanValue(flags['no-serve'], 'no-serve'),
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  const reportOnlyFlag = booleanValue(flags['report-only'], 'report-only');
  const noGateFlag = booleanValue(flags['no-gate'], 'no-gate');
  const reportOnly = reportOnlyFlag === true || noGateFlag === true;
  fieldSources.push(reportOnlyFlag !== undefined
    ? { normalizedField: 'values.presentation.exitMode', sourceKind: 'cli-flag', sourceKey: 'report-only' }
    : noGateFlag !== undefined
      ? { normalizedField: 'values.presentation.exitMode', sourceKind: 'cli-flag', sourceKey: 'no-gate' }
      : {
          normalizedField: 'values.presentation.exitMode', sourceKind: 'documented-default',
          sourceKey: 'values.presentation.exitMode', defaultSource: 'documented',
        });
  const noDiagnostic = pick({
    normalizedField: 'values.orchestration.diagnostic',
    cliKey: 'no-diagnostic', cliValue: booleanValue(flags['no-diagnostic'], 'no-diagnostic'),
    configKey: 'noDiagnostic', configValue: config?.noDiagnostic,
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  const skipDoctor = pick({
    normalizedField: 'values.orchestration.preflight.doctor',
    cliKey: 'skip-doctor', cliValue: booleanValue(flags['skip-doctor'], 'skip-doctor'),
    configKey: 'skipDoctor', configValue: config?.skipDoctor,
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  const configLocator = nonEmptyString(flags.config, 'config');
  if (configLocator !== undefined) fieldSources.push({
    normalizedField: 'values.locators.config', sourceKind: 'cli-flag', sourceKey: 'config',
  });
  const samplesLocator = pick({
    normalizedField: 'values.locators.samples',
    cliKey: 'samples', cliValue: nonEmptyString(flags.samples, 'samples'),
    configKey: 'samples', configValue: config?.samples,
    defaultValue: input.defaults.samplesLocator, defaultSource: 'derived',
  }) as string;
  const skillDirectoryLocator = pick({
    normalizedField: 'values.locators.skillDirectory',
    cliKey: 'skill-dir', cliValue: nonEmptyString(flags['skill-dir'], 'skill-dir'),
    defaultValue: input.defaults.skillDirectoryLocator, defaultSource: 'documented',
  }) as string;
  const mcpConfigLocator = pick({
    normalizedField: 'values.locators.mcpConfig',
    cliKey: 'mcp-config', cliValue: nonEmptyString(flags['mcp-config'], 'mcp-config'),
    configKey: 'mcpConfig', configValue: config?.mcpConfig,
  });
  const goldLocator = pick({
    normalizedField: 'values.locators.gold',
    cliKey: 'gold-dir', cliValue: nonEmptyString(flags['gold-dir'], 'gold-dir'),
    configKey: 'goldDir', configValue: config?.goldDir,
  });
  const executionConcurrency = pick({
    normalizedField: 'values.measurement.executionConcurrency',
    cliKey: 'concurrency',
    cliValue: numericValue(flags.concurrency, 'concurrency', { integer: true, min: 1 }),
    configKey: 'concurrency', configValue: numericValue(
      config?.concurrency, 'concurrency', { integer: true, min: 1 },
    ),
    defaultValue: 1, defaultSource: 'documented',
  }) as number;
  const retryCount = pick({
    normalizedField: 'values.measurement.retryCount',
    cliKey: 'retry', cliValue: numericValue(flags.retry, 'retry', { integer: true, min: 0 }),
    defaultValue: 0, defaultSource: 'documented',
  }) as number;
  const legacyCacheMode = (
    value: boolean | undefined,
    fieldPath: string,
  ): 'disabled' | undefined => {
    if (value === undefined) return undefined;
    if (value) return 'disabled';
    throw new CliEvaluationInputError({
      code: 'CLI_INPUT_LEGACY_CACHE_ENABLE_UNSUPPORTED',
      fieldPath,
      message: `输入字段「${fieldPath}」无法映射到新 Core：请在正式切换后使用显式 cache mode。`,
    });
  };
  const executionCacheMode = pick({
    normalizedField: 'values.measurement.cache.executionMode',
    cliKey: 'no-cache',
    cliValue: legacyCacheMode(booleanValue(flags['no-cache'], 'no-cache'), 'no-cache'),
    configKey: 'noCache',
    configValue: legacyCacheMode(booleanValue(config?.noCache, 'noCache'), 'noCache'),
    defaultValue: 'disabled' as const,
    defaultSource: 'documented',
  }) as 'disabled';
  const evaluationCacheMode = pick({
    normalizedField: 'values.measurement.cache.evaluationMode',
    defaultValue: 'disabled' as const,
    defaultSource: 'documented',
  }) as 'disabled';
  const threshold = pick({
    normalizedField: 'values.measurement.decision.threshold',
    cliKey: 'threshold', cliValue: numericValue(flags.threshold, 'threshold'),
    defaultSource: 'derived',
  });
  const trivialDifference = pick({
    normalizedField: 'values.measurement.decision.trivialDifference',
    cliKey: 'trivial-diff',
    cliValue: numericValue(flags['trivial-diff'], 'trivial-diff', { min: 0 }),
    defaultSource: 'derived',
  });
  const dryRun = pick({
    normalizedField: 'values.orchestration.dryRun',
    cliKey: 'dry-run', cliValue: booleanValue(flags['dry-run'], 'dry-run'),
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  const resumeSourceLocator = nonEmptyString(flags.resume, 'resume');
  if (resumeSourceLocator !== undefined) fieldSources.push({
    normalizedField: 'values.orchestration.resumeSourceLocator',
    sourceKind: 'cli-flag', sourceKey: 'resume',
  });
  const skipConnectivity = pick({
    normalizedField: 'values.orchestration.preflight.connectivity',
    cliKey: 'skip-connectivity',
    cliValue: booleanValue(flags['skip-connectivity'], 'skip-connectivity'),
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  const noEvidence = pick({
    normalizedField: 'values.orchestration.managedEvidence',
    cliKey: 'no-evidence', cliValue: booleanValue(flags['no-evidence'], 'no-evidence'),
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  const verbose = pick({
    normalizedField: 'values.presentation.verbose',
    cliKey: 'verbose', cliValue: booleanValue(flags.verbose, 'verbose'),
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;
  const layeredView = pick({
    normalizedField: 'values.presentation.layeredView',
    cliKey: 'layered-stats', cliValue: booleanValue(flags['layered-stats'], 'layered-stats'),
    defaultValue: false, defaultSource: 'documented',
  }) as boolean;

  const values: CliEvaluationRequestValues = {
    locators: {
      ...(configLocator === undefined ? {} : { config: configLocator }),
      samples: samplesLocator,
      skillDirectory: skillDirectoryLocator,
      ...(mcpConfigLocator === undefined ? {} : { mcpConfig: mcpConfigLocator }),
      ...(goldLocator === undefined ? {} : { gold: goldLocator }),
    },
    variants,
    targetRuntime: { executorId, model, effort: effort as CliEvaluationRequestValues['targetRuntime']['effort'] },
    judges: {
      enabled: !noJudge,
      members: judgeMembers,
      replicateCount: judgeReplicateCount,
      lengthDebias,
    },
    measurement: {
      baselineIsolation,
      executionConcurrency,
      timeoutMs: executionTimeoutMs,
      retryCount,
      cache: {
        executionMode: executionCacheMode,
        evaluationMode: evaluationCacheMode,
      },
      ...(holdoutRatio === undefined ? {} : { holdoutRatio }),
      bootstrap: { enabled: bootstrapEnabled, resamples: bootstrapResamples },
      decision: {
        ...(threshold === undefined ? {} : { threshold }),
        ...(trivialDifference === undefined ? {} : { trivialDifference }),
      },
      ...(hasBudget ? {
        budget: {
          ...(budgetTotal === undefined ? {} : { totalProviderCostUSD: budgetTotal }),
          ...(budgetCoordinateCost === undefined ? {} : {
            perCoordinateProviderCostUSD: budgetCoordinateCost,
          }),
          ...(budgetCoordinateDuration === undefined ? {} : {
            perCoordinateActiveDurationMs: budgetCoordinateDuration,
          }),
        },
      } : {}),
    },
    orchestration: {
      dryRun,
      batch,
      repeatCount,
      ...(resumeSourceLocator === undefined ? {} : { resumeSourceLocator }),
      preflight: {
        doctor: skipDoctor ? 'skip' : 'required',
        connectivity: skipConnectivity ? 'skip' : 'required',
      },
      diagnostic: noDiagnostic ? 'disabled' : 'enabled-outside-core',
      managedEvidence: noEvidence ? 'skip' : 'append',
    },
    presentation: {
      outputDirectoryLocator,
      indexScope: globalOutput ? 'global' : 'project',
      language,
      serve: !noServe,
      verbose,
      layeredView,
      exitMode: reportOnly ? 'report-only' : 'gate',
    },
  };

  return deepFreezeCanonicalJson({
    schemaVersion: CLI_EVALUATION_REQUEST_SCHEMA_VERSION,
    values,
    fieldSources,
  }) as unknown as CliEvaluationRequest;
}
