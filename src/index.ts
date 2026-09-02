import { createEvaluationEngine as createAdvancedEvaluationEngine } from './eval-core/engine/index.js';
import type {
  EvaluationEngine,
  EvaluationEngineRuntime,
} from './eval-core/engine/index.js';

/** Minimal one-call Evaluation Core facade. Advanced stages live at `oh-my-knowledge/eval-core`. */
export const createEvaluationEngine: (
  runtime: EvaluationEngineRuntime,
) => EvaluationEngine = createAdvancedEvaluationEngine;

export * from './eval-core/facade.js';
