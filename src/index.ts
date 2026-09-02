import { createEvaluationEngine as createAdvancedEvaluationEngine } from './evaluation-core/engine/index.js';
import type {
  EvaluationEngine,
  EvaluationEngineRuntime,
} from './evaluation-core/engine/index.js';

/** Minimal one-call Evaluation Core facade. Advanced stages live at `oh-my-knowledge/evaluation-core`. */
export const createEvaluationEngine: (
  runtime: EvaluationEngineRuntime,
) => EvaluationEngine = createAdvancedEvaluationEngine;

export * from './evaluation-core/facade.js';
