import { buildVariantConfig } from './execution-strategy.js';
import {
  buildExecutorRuntimesByVariant,
  EVALUATION_REPORT_SCHEMA_VERSION,
  getCliVersion,
} from './evaluation-reporting.js';
import { hashSample } from './sample-fingerprint.js';
import { getJudgePromptHash } from '../grading/judge.js';
import {
  getDiagnosticPromptHash,
  resolveDiagnosticTarget,
} from '../grading/diagnostic.js';
import { resolveExecutorRuntimeFingerprint } from '../executors/runtime-fingerprint.js';
import type {
  Artifact,
  EvalBudget,
  JudgeConfig,
  Report,
  Sample,
  Task,
} from '../types/index.js';

function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalStringify(record[key])}`
  ).join(',')}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function runtimeFingerprints(
  runtimes: Record<string, { fingerprint: string }> | undefined,
): Record<string, string> | undefined {
  if (!runtimes) return undefined;
  return Object.fromEntries(
    Object.entries(runtimes).map(([variant, runtime]) => [variant, runtime.fingerprint]),
  );
}

export interface ResumeCompatibilityInput {
  variants: string[];
  model: string;
  executorName: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  noJudge: boolean;
  judgeModels: JudgeConfig[];
  judgeRepeat?: number;
  lengthDebias?: boolean;
  budget?: EvalBudget;
  timeoutMs?: number;
  retry?: number;
  noDiagnostic?: boolean;
  skillDir: string;
  samples: Sample[];
  samplesBaseDir?: string;
  tasks: Task[];
  artifacts: Artifact[];
  executorOverrides?: Readonly<Record<string, import('../types/index.js').ExecutorFn>>;
}

export interface ResumeCompatibilityResult {
  compatible: boolean;
  mismatches: string[];
}

/**
 * Decide whether successful entries from an earlier report can be inserted
 * into the current measurement without mixing protocols. Every value compared
 * here is either the report's public measurement evidence or a request option
 * that can alter a persisted VariantResult.
 */
export function checkResumeCompatibility(
  report: Report,
  current: ResumeCompatibilityInput,
): ResumeCompatibilityResult {
  const mismatches: string[] = [];
  const check = (field: string, actual: unknown, expected: unknown): void => {
    if (!same(actual, expected)) mismatches.push(field);
  };

  check('meta.schemaVersion', report.meta.schemaVersion, EVALUATION_REPORT_SCHEMA_VERSION);
  check('meta.cliVersion', report.meta.cliVersion, getCliVersion());
  check('meta.nodeVersion', report.meta.nodeVersion, process.version);
  check('meta.variants', report.meta.variants, current.variants);
  check('meta.model', report.meta.model, current.model);
  check('meta.executor', report.meta.executor, current.executorName);
  check('meta.effort', report.meta.effort, current.effort);
  check('meta.noJudge', report.meta.noJudge === true, current.noJudge);
  check('meta.judgeRepeat', report.meta.judgeRepeat ?? 1, current.judgeRepeat ?? 1);
  check('meta.sampleCount', report.meta.sampleCount, current.samples.length);
  check('meta.taskCount', report.meta.taskCount, current.tasks.length);

  const expectedArtifactHashes = Object.fromEntries(
    current.artifacts.map((artifact) => [
      artifact.name,
      artifact.contentHash ?? 'no-skill',
    ]),
  );
  check('meta.artifactHashes', report.meta.artifactHashes, expectedArtifactHashes);

  const expectedSampleHashes = Object.fromEntries(
    current.samples.map((sample) => [
      sample.sample_id,
      hashSample(sample, current.samplesBaseDir),
    ]),
  );
  check('meta.sampleHashes', report.meta.sampleHashes, expectedSampleHashes);
  check(
    'meta.variantConfigs',
    report.meta.variantConfigs,
    current.artifacts.map(buildVariantConfig),
  );
  check(
    'meta.skillIsolation',
    report.meta.skillIsolation,
    Object.fromEntries(
      current.artifacts.map((artifact) => [
        artifact.name,
        artifact.allowedSkills ?? null,
      ]),
    ),
  );

  const expectedExecutorRuntimes = buildExecutorRuntimesByVariant({
    variants: current.variants,
    model: current.model,
    executorName: current.executorName,
    tasks: current.tasks,
    artifacts: current.artifacts,
    request: {
      skillDir: current.skillDir,
      timeoutMs: current.timeoutMs,
    },
    executor: current.executorOverrides?.[current.executorName],
  });
  check(
    'meta.executorRuntimes',
    runtimeFingerprints(report.meta.executorRuntimes),
    runtimeFingerprints(expectedExecutorRuntimes),
  );

  const actualJudges = report.meta.judgeModels.map((judge) => ({
    executor: judge.executor,
    model: judge.model,
    runtime: judge.runtime?.fingerprint,
  }));
  const expectedJudges = current.judgeModels.map((judge) => ({
    executor: judge.executor,
    model: judge.model,
    ...(!current.noJudge
      ? {
        runtime: resolveExecutorRuntimeFingerprint(judge.executor, judge.model, {
          skillDir: current.skillDir,
        }, current.executorOverrides?.[judge.executor]).fingerprint,
      }
      : {}),
  }));
  check('meta.judgeModels', actualJudges, expectedJudges);
  if (!current.noJudge) {
    check(
      'meta.judgePromptHash',
      report.meta.judgePromptHash,
      getJudgePromptHash(current.lengthDebias !== false),
    );
  }

  const diagnosticEnabled = current.noDiagnostic !== true;
  const diagnosticTarget = resolveDiagnosticTarget(
    current.judgeModels,
    current.executorName,
    current.model,
  );
  const expectedDiagnostic = diagnosticEnabled
    ? {
      enabled: true,
      executor: diagnosticTarget.executor,
      model: diagnosticTarget.model,
      runtime: resolveExecutorRuntimeFingerprint(
        diagnosticTarget.executor,
        diagnosticTarget.model,
        {},
        current.executorOverrides?.[diagnosticTarget.executor],
      ).fingerprint,
      promptHash: getDiagnosticPromptHash(),
    }
    : { enabled: false };
  const actualDiagnostic = report.meta.diagnostic
    ? {
      enabled: report.meta.diagnostic.enabled,
      ...(report.meta.diagnostic.executor
        ? { executor: report.meta.diagnostic.executor }
        : {}),
      ...(report.meta.diagnostic.model ? { model: report.meta.diagnostic.model } : {}),
      ...(report.meta.diagnostic.runtime
        ? { runtime: report.meta.diagnostic.runtime.fingerprint }
        : {}),
      ...(report.meta.diagnostic.promptHash
        ? { promptHash: report.meta.diagnostic.promptHash }
        : {}),
    }
    : undefined;
  check('meta.diagnostic', actualDiagnostic, expectedDiagnostic);

  const request = report.meta.request;
  if (!request) {
    mismatches.push('meta.request');
  } else {
    check('meta.request.timeoutMs', request.timeoutMs, current.timeoutMs);
    check('meta.request.budget', request.budget, current.budget);
    check('meta.request.retry', request.retry ?? 0, current.retry ?? 0);
    check(
      'meta.request.noDiagnostic',
      request.noDiagnostic === true,
      current.noDiagnostic === true,
    );
  }

  if (report.meta.budgetExhausted) mismatches.push('meta.budgetExhausted');
  return {
    compatible: mismatches.length === 0,
    mismatches: [...new Set(mismatches)],
  };
}
