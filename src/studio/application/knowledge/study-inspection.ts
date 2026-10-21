import { reserveExtractionStudyInspection } from '../../../knowledge/application/study-inspection-service.js';

/** Reserve before HTTP reads private bytes; the fixed worker owns parsing, hashing and replay. */
export function reserveKnowledgeStudyInspection(signal?: AbortSignal) {
  return reserveExtractionStudyInspection(signal);
}
