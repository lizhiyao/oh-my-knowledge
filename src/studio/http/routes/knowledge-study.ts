import { executeKnowledgeStudyInspection } from '../../application/knowledge/study-inspection.js';
import { ExtractionStudyInspectionError } from '../../../knowledge/application/study-inspection.js';
import { EXTRACTION_STUDY_INSPECTION_MAX_BYTES } from '../../../knowledge/extraction/study-capacity.js';
import { JSON_HEADERS, writeJsonError } from '../errors.js';
import { readJsonObjectBody } from '../request-errors.js';
import { createStudioRouter } from './router.js';

/** Read-only POST retains the same-origin guard because the selected evidence can be private. */
export function createKnowledgeStudyRoutes() {
  return createStudioRouter([{
    pattern: '/api/knowledge/study', method: 'POST', mutation: true,
    async handler({ request, response }) {
      const input = await readJsonObjectBody(request, EXTRACTION_STUDY_INSPECTION_MAX_BYTES);
      try {
        const result = executeKnowledgeStudyInspection(input);
        response.writeHead(200, JSON_HEADERS); response.end(JSON.stringify(result));
      } catch (error) {
        const code = error instanceof ExtractionStudyInspectionError ? error.code : 'knowledge_study_evidence_invalid';
        writeJsonError(response, code === 'knowledge_study_capacity_exceeded' ? 413 : 400, code);
      }
    },
  }]);
}
