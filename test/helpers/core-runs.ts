// Test-only Promise conveniences around the actual streaming Core APIs.
// async preserves rejection semantics when a start API throws synchronously.
import { startExecution } from '../../src/eval-core/execution/runtime.js';
import { startEvaluation } from '../../src/eval-core/evaluation/runtime.js';
import { startAnalysis } from '../../src/eval-core/analysis/runtime.js';
import { startDecision } from '../../src/eval-core/analysis/decision.js';

export async function executeRunPlan(...args: Parameters<typeof startExecution>) {
  return startExecution(...args).result;
}

export async function executeRunPlanSource(...args: Parameters<typeof startExecution>) {
  return startExecution(...args).source;
}

export async function evaluateExecutionBundle(...args: Parameters<typeof startEvaluation>) {
  return startEvaluation(...args).result;
}

export async function evaluateExecutionBundleSource(...args: Parameters<typeof startEvaluation>) {
  return startEvaluation(...args).source;
}

export async function analyzeEvaluationBundle(...args: Parameters<typeof startAnalysis>) {
  return startAnalysis(...args).result;
}

export async function analyzeEvaluationBundleSource(...args: Parameters<typeof startAnalysis>) {
  return startAnalysis(...args).source;
}

export async function decideAnalysis(...args: Parameters<typeof startDecision>) {
  return startDecision(...args).result;
}

export async function decideAnalysisSource(...args: Parameters<typeof startDecision>) {
  return startDecision(...args).source;
}
