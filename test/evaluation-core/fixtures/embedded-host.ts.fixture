import {
  createEvaluationEngine,
  type EvaluationDefinition,
  type EvaluationEngineRuntime,
  type EvaluationEvent,
  type EvaluationRunResult,
  type Evaluator,
  type Executor,
  type MeasurementPolicy,
} from 'oh-my-knowledge';

declare const runtime: EvaluationEngineRuntime;
declare const definition: EvaluationDefinition;
declare const policy: MeasurementPolicy;
declare const executor: Executor;
declare const evaluator: Evaluator;

const engine = createEvaluationEngine({
  ...runtime,
  executors: new Map([['same-process', executor]]),
  evaluators: new Map([['deterministic/v1', evaluator]]),
});
const run = engine.start(definition, { policy, runId: 'typescript-host' });

async function consume(): Promise<EvaluationRunResult> {
  for await (const event of run.events) {
    const serialized: EvaluationEvent = event;
    JSON.stringify(serialized);
  }
  return run.result;
}

void consume;
