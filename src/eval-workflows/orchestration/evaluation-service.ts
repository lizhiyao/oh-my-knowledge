import { createProductionEvaluationWorkflow, type ProductionEvaluationWorkflowInput } from './workflow.js';
import { executeProductionEvaluationSeries } from './orchestration.js';
import {
  projectCoreCliDryRun,
  projectCoreCliRunOutcome,
  projectCoreCliSeriesOutcome,
} from '../projections/cli.js';
import type {
  CoreCliDryRunProjection,
  CoreCliRunOutcome,
  CoreCliSeriesOutcome,
} from '../projections/contracts.js';
import type { StoredCoreRunArtifacts } from '../artifact-store/index.js';
import type { OmkEvaluationProgressSink } from '../projections/runtime-progress.js';
import type { CliEvaluationRequest } from '../input-compilation/index.js';
import { generateRunId } from '../../evidence/storage/run-id.js';

export type ProductEvaluationResult =
  | { readonly outcomeKind: 'dry-run'; readonly outcome: CoreCliDryRunProjection }
  | { readonly outcomeKind: 'run'; readonly outcome: CoreCliRunOutcome; readonly artifacts: StoredCoreRunArtifacts }
  | { readonly outcomeKind: 'series'; readonly outcome: CoreCliSeriesOutcome; readonly artifacts: readonly StoredCoreRunArtifacts[] };

export interface ProductEvaluationExecutionInput {
  readonly host: ProductionEvaluationWorkflowInput;
  readonly request: CliEvaluationRequest;
  readonly signal?: AbortSignal;
  readonly createProgressSink?: () => OmkEvaluationProgressSink;
  readonly idPrefix?: string;
}

/** The shared product policy for preparation, single runs, resume and independent Series. */
export async function executeProductEvaluation(input: ProductEvaluationExecutionInput): Promise<ProductEvaluationResult> {
  const { host, request } = input;
  const options = () => ({ signal: input.signal, progressSink: input.createProgressSink?.() });
  const id = (name: string) => generateRunId([`${input.idPrefix ?? ''}${name}`]);
  const projection = {
    exitMode: request.values.presentation.exitMode,
    diagnosticMode: host.compiled.orchestration.diagnostic === 'enabled-outside-core'
      ? 'enabled' as const : 'disabled' as const,
  };
  if (host.compiled.orchestration.dryRun) {
    const prepared = await createProductionEvaluationWorkflow(host).prepare({ signal: input.signal });
    return { outcomeKind: 'dry-run', outcome: projectCoreCliDryRun({ plan: prepared.plan, preflight: prepared.preflight }) };
  }
  const locator = request.values.orchestration.resumeSourceLocator?.trim();
  const sourceRunId = locator === '' ? undefined : locator;
  if (sourceRunId !== undefined && !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(sourceRunId)) {
    throw new TypeError('--resume 只接受 Core runId，不接受旧报告路径。');
  }
  const independentSeries = host.compiled.orchestration.independentSeries;
  if (independentSeries !== undefined) {
    if (sourceRunId !== undefined) throw new TypeError('Independent Series resume 必须按 member runId 单独执行。');
    const createdAt = new Date().toISOString();
    const series = await executeProductionEvaluationSeries({
      host,
      members: independentSeries.memberships.map((membership) => ({
        runId: generateRunId([membership.memberId]), createdAt, ...options(),
      })),
      bundleId: id('series-analysis'), reportId: id('series-report'),
      seriesSignal: input.signal,
      preflight: { signal: input.signal },
    });
    await series.result;
    const evolution = await series.evolution;
    if (evolution === undefined) throw new Error('Core Series 未完成，无法生成 evolution evidence。');
    const artifacts = await Promise.all(series.members.map(async (member) => {
      if (member.executionStatus !== 'started') throw member.error;
      const persistence = await member.run.persistence;
      await member.run.result;
      if (persistence.persistenceStatus !== 'stored') {
        if (persistence.persistenceStatus === 'failed') throw persistence.error;
        throw new Error(`Core Series member 产物未保存：${persistence.reasonCode}`);
      }
      return persistence.artifacts;
    }));
    return { outcomeKind: 'series', artifacts, outcome: projectCoreCliSeriesOutcome({ evolution, members: artifacts, ...projection }) };
  }
  const prepared = await createProductionEvaluationWorkflow(host).prepare({ signal: input.signal });
  let artifacts: StoredCoreRunArtifacts;
  if (sourceRunId !== undefined) {
    const admission = await prepared.admitResume({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      policy: { rejectionMode: 'fail-closed', minimumSourceTrust: 'unknown', cacheReceiptMode: 'allow-indeterminate', budgetVerificationMode: 'allow-indeterminate' },
    });
    if (admission.disposition !== 'reuse') throw new Error(`Core resume 被拒绝：${admission.reasonCode}`);
    artifacts = admission.artifacts;
  } else {
    const run = await prepared.execute({
      runId: generateRunId(prepared.plan.execution.targets.map((target) => target.targetId)),
      createdAt: new Date().toISOString(), ...options(),
    });
    const persistence = await run.persistence;
    await run.result;
    if (persistence.persistenceStatus !== 'stored') {
      if (persistence.persistenceStatus === 'failed') throw persistence.error;
      throw new Error(`Core 产物未保存：${persistence.reasonCode}`);
    }
    artifacts = persistence.artifacts;
  }
  return { outcomeKind: 'run', artifacts, outcome: projectCoreCliRunOutcome(artifacts, projection) };
}
