import type { JsonValue } from '../../eval-core/contracts/index.js';
import { DEFAULT_EVALUATION_TIMEOUT_MS } from '../evaluation-defaults.js';

export type CliInputRegistryOwner =
  | 'Definition'
  | 'MeasurementPolicy'
  | 'RuntimeBinding'
  | 'Orchestration'
  | 'Presentation'
  | 'RunOptions';

export type CliInputDigestStage =
  | 'execution'
  | 'evaluation'
  | 'analysis'
  | 'decision'
  | 'run'
  | 'none';

export interface CliInputInvalidCombination {
  readonly sourceKeys: readonly string[];
  readonly errorCode: string;
}

export interface CliEvaluationInputRegistryEntry {
  readonly sourceKind: 'cli-flag' | 'eval-config';
  readonly sourceKey: string;
  readonly normalizedField: string;
  readonly precedence: 300 | 200;
  readonly defaultValue?: JsonValue;
  readonly defaultSource: 'documented' | 'environment-selection' | 'derived' | 'none';
  readonly owner: CliInputRegistryOwner;
  readonly digestStage: CliInputDigestStage;
  readonly runtimeQualificationRequirements: readonly string[];
  readonly invalidCombinations: readonly CliInputInvalidCombination[];
  readonly errorCode: string;
  readonly migration: {
    readonly migrationKind: 'retain' | 'rename' | 'remove' | 'replace';
    readonly target?: string;
  };
  readonly summary: { readonly zh: string; readonly en: string };
}

type EntryInput = Omit<
  CliEvaluationInputRegistryEntry,
  'precedence' | 'defaultSource' | 'runtimeQualificationRequirements'
  | 'invalidCombinations' | 'errorCode' | 'migration' | 'summary'
> & Partial<Pick<
  CliEvaluationInputRegistryEntry,
  'defaultSource' | 'runtimeQualificationRequirements' | 'invalidCombinations'
  | 'errorCode' | 'migration' | 'summary'
>>;

function entry(input: EntryInput): CliEvaluationInputRegistryEntry {
  return {
    ...input,
    precedence: input.sourceKind === 'cli-flag' ? 300 : 200,
    defaultSource: input.defaultSource ?? 'none',
    runtimeQualificationRequirements: input.runtimeQualificationRequirements ?? [],
    invalidCombinations: input.invalidCombinations ?? [],
    errorCode: input.errorCode ?? 'CLI_INPUT_INVALID',
    migration: input.migration ?? { migrationKind: 'retain' },
    summary: input.summary ?? { zh: input.normalizedField, en: input.normalizedField },
  };
}

const cli = (
  sourceKey: string,
  normalizedField: string,
  owner: CliInputRegistryOwner,
  digestStage: CliInputDigestStage,
  options: Partial<EntryInput> = {},
): CliEvaluationInputRegistryEntry => entry({
  sourceKind: 'cli-flag', sourceKey, normalizedField, owner, digestStage, ...options,
});

const config = (
  sourceKey: string,
  normalizedField: string,
  owner: CliInputRegistryOwner,
  digestStage: CliInputDigestStage,
  options: Partial<EntryInput> = {},
): CliEvaluationInputRegistryEntry => entry({
  sourceKind: 'eval-config', sourceKey, normalizedField, owner, digestStage, ...options,
});

/**
 * Exhaustive classification of the current `omk eval` flags and eval config
 * schema. Tests compare these source-key sets with both live inputs.
 */
export const CLI_EVALUATION_INPUT_REGISTRY = [
  cli('lang', 'presentation.language', 'Presentation', 'none', {
    defaultValue: 'zh', defaultSource: 'environment-selection',
  }),
  cli('control', 'definition.targets.control', 'Definition', 'execution'),
  cli('treatment', 'definition.targets.treatments', 'Definition', 'execution'),
  cli('control-cwd', 'resources.controlWorkspaceLocator', 'Orchestration', 'none'),
  cli('treatment-cwd', 'resources.treatmentWorkspaceLocators', 'Orchestration', 'none'),
  cli('config', 'orchestration.configLocator', 'Orchestration', 'none'),
  cli('samples', 'orchestration.samplesLocator', 'Orchestration', 'none'),
  cli('skill-dir', 'orchestration.skillDirectoryLocator', 'Orchestration', 'none', {
    defaultValue: 'skills', defaultSource: 'documented',
  }),
  cli('model', 'definition.targetRuntime.model', 'Definition', 'execution', {
    defaultSource: 'environment-selection',
    runtimeQualificationRequirements: ['model-effort'],
  }),
  cli('executor', 'definition.targetRuntime.implementationId', 'Definition', 'execution', {
    defaultSource: 'environment-selection',
    runtimeQualificationRequirements: ['executor-protocol', 'model-effort'],
  }),
  cli('judge-models', 'definition.judges.members', 'Definition', 'evaluation', {
    defaultSource: 'environment-selection',
    runtimeQualificationRequirements: ['evaluator-instrument', 'model-effort'],
  }),
  cli('output-dir', 'presentation.outputDirectoryLocator', 'Presentation', 'none'),
  cli('global', 'presentation.indexScope', 'Presentation', 'none', {
    defaultValue: 'project', defaultSource: 'documented',
  }),
  cli('no-judge', 'definition.judges.enabled', 'Definition', 'evaluation', {
    defaultValue: true, defaultSource: 'documented',
  }),
  cli('no-cache', 'policy.cache.executionMode', 'MeasurementPolicy', 'execution', {
    defaultValue: 'disabled', defaultSource: 'documented',
    errorCode: 'CLI_INPUT_LEGACY_CACHE_ENABLE_UNSUPPORTED',
    migration: {
      migrationKind: 'replace',
      target: '--execution-cache-mode / --evaluation-cache-mode',
    },
  }),
  cli('dry-run', 'orchestration.dryRun', 'Orchestration', 'none', {
    defaultValue: false, defaultSource: 'documented',
  }),
  cli('concurrency', 'policy.executionConcurrency', 'MeasurementPolicy', 'execution', {
    defaultValue: 1, defaultSource: 'documented',
  }),
  cli('timeout', 'policy.executionTimeoutMs', 'MeasurementPolicy', 'execution', {
    defaultValue: DEFAULT_EVALUATION_TIMEOUT_MS, defaultSource: 'documented',
  }),
  cli('batch', 'orchestration.batch', 'Orchestration', 'none', {
    defaultValue: false, defaultSource: 'documented',
  }),
  cli('skip-connectivity', 'orchestration.preflight.connectivity', 'Orchestration', 'none', {
    defaultValue: 'required', defaultSource: 'documented',
  }),
  cli('skip-doctor', 'orchestration.preflight.doctor', 'Orchestration', 'none', {
    defaultValue: 'required', defaultSource: 'documented',
  }),
  cli('mcp-config', 'resources.mcpConfigLocator', 'Orchestration', 'none', {
    runtimeQualificationRequirements: ['tool-mock-sandbox'],
  }),
  cli('no-serve', 'presentation.serve', 'Presentation', 'none', {
    defaultValue: true, defaultSource: 'documented',
  }),
  cli('verbose', 'presentation.verbose', 'Presentation', 'none', {
    defaultValue: false, defaultSource: 'documented',
  }),
  cli('retry', 'policy.retryCount', 'MeasurementPolicy', 'execution', {
    defaultValue: 0, defaultSource: 'documented',
  }),
  cli('resume', 'orchestration.resumeSourceLocator', 'Orchestration', 'none'),
  cli('layered-stats', 'presentation.layeredView', 'Presentation', 'none', {
    defaultValue: false, defaultSource: 'documented',
  }),
  cli('strict-baseline', 'definition.baselineIsolation', 'Definition', 'execution', {
    defaultValue: true, defaultSource: 'documented',
    invalidCombinations: [{
      sourceKeys: ['--strict-baseline', '--no-strict-baseline'],
      errorCode: 'CLI_INPUT_BASELINE_ISOLATION_CONFLICT',
    }],
  }),
  cli('no-strict-baseline', 'definition.baselineIsolation', 'Definition', 'execution', {
    defaultValue: true, defaultSource: 'documented',
    invalidCombinations: [{
      sourceKeys: ['--strict-baseline', '--no-strict-baseline'],
      errorCode: 'CLI_INPUT_BASELINE_ISOLATION_CONFLICT',
    }],
  }),
  cli('effort', 'definition.targetRuntime.effort', 'Definition', 'execution', {
    defaultValue: 'low', defaultSource: 'documented',
    runtimeQualificationRequirements: ['model-effort'],
  }),
  cli('no-diagnostic', 'orchestration.diagnostic', 'Orchestration', 'none', {
    defaultValue: 'enabled-outside-core', defaultSource: 'documented',
  }),
  cli('repeat', 'orchestration.independentSeries.repeatCount', 'Orchestration', 'run', {
    defaultValue: 1, defaultSource: 'documented',
  }),
  cli('holdout-ratio', 'definition.dataset.analysisCohorts', 'Definition', 'analysis'),
  cli('judge-repeat', 'definition.judges.replicateCount', 'Definition', 'evaluation', {
    defaultValue: 1, defaultSource: 'documented',
  }),
  cli('bootstrap', 'definition.analysisGraph.bootstrap', 'Definition', 'analysis', {
    defaultValue: true, defaultSource: 'documented',
  }),
  cli('bootstrap-samples', 'definition.analysisGraph.bootstrap.resamples', 'Definition', 'analysis', {
    defaultValue: 1000, defaultSource: 'documented',
  }),
  cli('gold-dir', 'orchestration.gold.resourceLocator', 'Orchestration', 'none'),
  cli('no-debias-length', 'definition.judges.lengthDebias', 'Definition', 'evaluation', {
    defaultValue: true, defaultSource: 'documented',
  }),
  cli('budget-usd', 'policy.budget.totalProviderCostUSD', 'MeasurementPolicy', 'run'),
  cli('budget-per-sample-usd', 'policy.budget.perCoordinateProviderCostUSD', 'MeasurementPolicy', 'run'),
  cli('budget-per-sample-ms', 'policy.budget.perCoordinateActiveDurationMs', 'MeasurementPolicy', 'run'),
  cli('threshold', 'definition.decisionPolicy.threshold', 'Definition', 'decision', {
    defaultSource: 'derived',
  }),
  cli('trivial-diff', 'definition.decisionPolicy.trivialDifference', 'Definition', 'decision', {
    defaultSource: 'derived',
  }),
  cli('report-only', 'presentation.exitMode', 'Presentation', 'none', {
    defaultValue: 'gate', defaultSource: 'documented',
  }),
  cli('no-gate', 'presentation.exitMode', 'Presentation', 'none', {
    defaultValue: 'gate', defaultSource: 'documented',
    migration: { migrationKind: 'rename', target: '--report-only' },
  }),
  cli('no-evidence', 'orchestration.managedEvidence', 'Orchestration', 'none', {
    defaultValue: 'append', defaultSource: 'documented',
  }),

  config('samples', 'orchestration.samplesLocator', 'Orchestration', 'none'),
  config('executor', 'definition.targetRuntime.implementationId', 'Definition', 'execution', {
    defaultSource: 'environment-selection',
    runtimeQualificationRequirements: ['executor-protocol', 'model-effort'],
  }),
  config('model', 'definition.targetRuntime.model', 'Definition', 'execution', {
    defaultSource: 'environment-selection', runtimeQualificationRequirements: ['model-effort'],
  }),
  config('effort', 'definition.targetRuntime.effort', 'Definition', 'execution', {
    defaultValue: 'low', defaultSource: 'documented', runtimeQualificationRequirements: ['model-effort'],
  }),
  config('noDiagnostic', 'orchestration.diagnostic', 'Orchestration', 'none', {
    defaultValue: 'enabled-outside-core', defaultSource: 'documented',
  }),
  config('skipDoctor', 'orchestration.preflight.doctor', 'Orchestration', 'none', {
    defaultValue: 'required', defaultSource: 'documented',
  }),
  config('judgeModels', 'definition.judges.members', 'Definition', 'evaluation', {
    defaultSource: 'environment-selection', runtimeQualificationRequirements: ['evaluator-instrument'],
  }),
  config('judgeModels[].executor', 'definition.judges.members[].executorId', 'Definition', 'evaluation', {
    runtimeQualificationRequirements: ['evaluator-instrument'],
  }),
  config('judgeModels[].model', 'definition.judges.members[].model', 'Definition', 'evaluation', {
    runtimeQualificationRequirements: ['model-effort'],
  }),
  config('concurrency', 'policy.executionConcurrency', 'MeasurementPolicy', 'execution', {
    defaultValue: 1, defaultSource: 'documented',
  }),
  config('timeoutMs', 'policy.executionTimeoutMs', 'MeasurementPolicy', 'execution', {
    defaultValue: DEFAULT_EVALUATION_TIMEOUT_MS, defaultSource: 'documented',
  }),
  config('noCache', 'policy.cache.executionMode', 'MeasurementPolicy', 'execution', {
    defaultValue: 'disabled', defaultSource: 'documented',
    errorCode: 'CLI_INPUT_LEGACY_CACHE_ENABLE_UNSUPPORTED',
    migration: {
      migrationKind: 'replace',
      target: 'cache.executionMode / cache.evaluationMode',
    },
  }),
  config('noJudge', 'definition.judges.enabled', 'Definition', 'evaluation', {
    defaultValue: true, defaultSource: 'documented',
  }),
  config('mcpConfig', 'resources.mcpConfigLocator', 'Orchestration', 'none', {
    runtimeQualificationRequirements: ['tool-mock-sandbox'],
  }),
  config('variants', 'definition.targets', 'Definition', 'execution'),
  config('variants[].name', 'definition.targets[].targetId', 'Definition', 'execution'),
  config('variants[].role', 'definition.targets[].experimentRole', 'Definition', 'execution'),
  config('variants[].artifact', 'resources.targets[].artifactLocator', 'Orchestration', 'none'),
  config('variants[].git', 'resources.targets[].gitSource', 'Orchestration', 'none'),
  config('variants[].git.url', 'resources.targets[].gitSource.url', 'Orchestration', 'none'),
  config('variants[].git.ref', 'resources.targets[].gitSource.ref', 'Orchestration', 'none'),
  config('variants[].git.spec', 'resources.targets[].gitSource.spec', 'Orchestration', 'none'),
  config('variants[].cwd', 'resources.targets[].workspaceLocator', 'Orchestration', 'none'),
  config('variants[].allowedSkills', 'definition.targets[].behavior.allowedSkills', 'Definition', 'execution'),
  config('budget', 'policy.budget', 'MeasurementPolicy', 'run'),
  config('budget.totalUSD', 'policy.budget.totalProviderCostUSD', 'MeasurementPolicy', 'run'),
  config('budget.perSampleUSD', 'policy.budget.perCoordinateProviderCostUSD', 'MeasurementPolicy', 'run'),
  config('budget.perSampleMs', 'policy.budget.perCoordinateActiveDurationMs', 'MeasurementPolicy', 'run'),
  config('repeat', 'orchestration.independentSeries.repeatCount', 'Orchestration', 'run', {
    defaultValue: 1, defaultSource: 'documented',
  }),
  config('holdoutRatio', 'definition.dataset.analysisCohorts', 'Definition', 'analysis'),
  config('judgeRepeat', 'definition.judges.replicateCount', 'Definition', 'evaluation', {
    defaultValue: 1, defaultSource: 'documented',
  }),
  config('bootstrap', 'definition.analysisGraph.bootstrap', 'Definition', 'analysis', {
    defaultValue: true, defaultSource: 'documented',
  }),
  config('bootstrapSamples', 'definition.analysisGraph.bootstrap.resamples', 'Definition', 'analysis', {
    defaultValue: 1000, defaultSource: 'documented',
  }),
  config('goldDir', 'orchestration.gold.resourceLocator', 'Orchestration', 'none'),
  config('lengthDebias', 'definition.judges.lengthDebias', 'Definition', 'evaluation', {
    defaultValue: true, defaultSource: 'documented',
  }),
  config('strictBaseline', 'definition.baselineIsolation', 'Definition', 'execution', {
    defaultValue: true, defaultSource: 'documented',
  }),
] as const satisfies readonly CliEvaluationInputRegistryEntry[];

export function cliEvaluationRegistrySourceKeys(
  sourceKind: CliEvaluationInputRegistryEntry['sourceKind'],
): string[] {
  return CLI_EVALUATION_INPUT_REGISTRY
    .filter((candidate) => candidate.sourceKind === sourceKind)
    .map((candidate) => candidate.sourceKey)
    .sort();
}

export function renderCliEvaluationInputRegistryMarkdown(
  language: 'zh' | 'en',
): string {
  const header = language === 'zh'
    ? '| 来源 | 字段 | 规范字段 | 优先级 | 规范默认值（来源） | Owner | Digest 阶段 | Runtime qualification | 错误／迁移 |\n|---|---|---|---:|---|---|---|---|---|'
    : '| Source | Field | Normalized field | Priority | Normalized default (source) | Owner | Digest stage | Runtime qualification | Error / migration |\n|---|---|---|---:|---|---|---|---|---|';
  const sourceLabel = (sourceKind: CliEvaluationInputRegistryEntry['sourceKind']): string => (
    sourceKind === 'cli-flag' ? 'CLI' : 'eval.yaml'
  );
  const rows = [...CLI_EVALUATION_INPUT_REGISTRY]
    .sort((left, right) => (
      left.sourceKind.localeCompare(right.sourceKind)
      || left.sourceKey.localeCompare(right.sourceKey)
    ))
    .map((candidate) => {
      const migration = candidate.migration.target === undefined
        ? candidate.migration.migrationKind
        : `${candidate.migration.migrationKind} → ${candidate.migration.target}`;
      const key = candidate.sourceKind === 'cli-flag'
        ? `--${candidate.sourceKey}`
        : candidate.sourceKey;
      const defaultValue = candidate.defaultValue === undefined
        ? '—'
        : `\`${JSON.stringify(candidate.defaultValue)}\``;
      const defaultSource = candidate.defaultSource === 'none'
        ? defaultValue
        : `${defaultValue} (${candidate.defaultSource})`;
      const qualification = candidate.runtimeQualificationRequirements.length === 0
        ? '—'
        : candidate.runtimeQualificationRequirements.map((value) => `\`${value}\``).join('<br>');
      const combinationErrors = candidate.invalidCombinations
        .map((value) => value.errorCode);
      const errors = [...new Set([candidate.errorCode, ...combinationErrors])]
        .map((value) => `\`${value}\``)
        .join('<br>');
      return `| ${sourceLabel(candidate.sourceKind)} | \`${key}\` | \`${candidate.normalizedField}\` | ${candidate.precedence} | ${defaultSource} | ${candidate.owner} | ${candidate.digestStage} | ${qualification} | ${errors}<br>${migration} |`;
    });
  return [header, ...rows].join('\n');
}
