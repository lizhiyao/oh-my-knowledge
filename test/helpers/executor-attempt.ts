import { digestCanonicalJson, type JsonValue } from '../../src/eval-core/contracts/index.js';
import type { ExecutionExecutor, ExecutorAttemptResult, ExecutorTrialContext } from '../../src/eval-core/execution/index.js';

/** One fixed trial for adapter protocol tests, releasing its run even when openTrial fails. */
export async function executeFixtureAttempt(
  port: ExecutionExecutor,
  targetConfig: JsonValue,
  signal: AbortSignal = new AbortController().signal,
  input: JsonValue = { question: 'Q' },
  executionControl: ExecutorTrialContext['executionControl'] = {
    workspace: { workspaceMode: 'not-required' },
    tools: { toolPolicyKind: 'runtime-default' },
    mcp: { mcpMode: 'not-required' },
    mockInterception: { mockInterceptionMode: 'not-required' },
  },
): Promise<ExecutorAttemptResult> {
  const run = await port.openRun({ runId: 'run-a', executionPlanDigest: digestCanonicalJson({ plan: 'a' }) });
  let trial: Awaited<ReturnType<typeof run.openTrial>> | undefined;
  try {
    trial = await run.openTrial({
      signal: new AbortController().signal,
      sampleId: 'sample-a',
      targetId: 'target-a',
      executionCoordinateDigest: digestCanonicalJson({ coordinate: 'a' }),
      executionControl,
      protocolId: 'omk.invoke/v1',
      input,
      executionContext: { locale: 'zh-CN' },
      targetConfig,
      trialIndex: 0,
      trialId: digestCanonicalJson({ trial: 'a' }),
      schedulingBlockId: digestCanonicalJson({ block: 'a' }),
      samplingUnitIds: {},
    });
    return await trial.execute({
      attemptId: digestCanonicalJson({ attempt: 'a' }),
      attemptNumber: 1,
      signal,
    });
  } finally {
    try { await trial?.dispose(); } finally { await run.dispose(); }
  }
}
