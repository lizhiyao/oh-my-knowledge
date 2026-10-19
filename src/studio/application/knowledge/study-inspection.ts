import { inspectExtractionStudy } from '../../../knowledge/application/study-inspection.js';

/** Portable input is inspected independently of the active workspace and never persisted. */
export function executeKnowledgeStudyInspection(input: unknown) {
  return inspectExtractionStudy(input);
}
