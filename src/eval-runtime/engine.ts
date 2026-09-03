import { createEvaluationEngine as createAdvancedEvaluationEngine } from '../eval-core/engine/index.js';
import type {
  EvaluationEngine,
  EvaluationEngineRuntime,
} from '../eval-core/engine/index.js';

/** Standard one-call host façade. Staged execution remains explicit at `eval-core`. */
export const createEvaluationEngine: (
  runtime: EvaluationEngineRuntime,
) => EvaluationEngine = createAdvancedEvaluationEngine;
