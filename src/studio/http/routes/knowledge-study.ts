import { reserveKnowledgeStudyInspection } from '../../application/knowledge/study-inspection.js';
import { ExtractionStudyBodyError, ExtractionStudyInspectionError } from '../../../knowledge/adapters/study-inspection-errors.js';
import { EXTRACTION_STUDY_INSPECTION_MAX_BYTES } from '../../../knowledge/extraction/study-capacity.js';
import { JSON_HEADERS, writeJsonError } from '../errors.js';
import { readJsonBodyBytes, RequestBodyError } from '../request-errors.js';
import { createStudioRouter } from './router.js';
import type { LiveStreamRegistry } from './contracts.js';

/** Read-only POST retains the same-origin guard because the selected evidence can be private. */
export function createKnowledgeStudyRoutes(liveStreams: LiveStreamRegistry) {
  return createStudioRouter([{
    pattern: '/api/knowledge/study', method: 'POST', mutation: true,
    async handler({ request, response, lang }) {
      const controller = new AbortController(), cancel = () => controller.abort();
      response.once('close', cancel); liveStreams.add(cancel);
      let lease: ReturnType<typeof reserveKnowledgeStudyInspection> | undefined;
      try {
        lease = reserveKnowledgeStudyInspection(controller.signal);
        const bytes = await readJsonBodyBytes(request, EXTRACTION_STUDY_INSPECTION_MAX_BYTES, controller.signal);
        const result = await lease.inspect({ inputKind: 'bytes', bytes: bytes.buffer });
        if (!response.destroyed) { response.writeHead(200, JSON_HEADERS); response.end(JSON.stringify(result)); }
      } catch (error) {
        if (response.destroyed) return;
        if (error instanceof RequestBodyError) throw error;
        if (error instanceof ExtractionStudyBodyError) { writeJsonError(response, 400, error.code); return; }
        const code = error instanceof ExtractionStudyInspectionError ? error.code : 'knowledge_study_unavailable';
        if (code === 'knowledge_study_busy' || code === 'knowledge_study_unavailable') {
          const message = code === 'knowledge_study_busy'
            ? lang === 'zh' ? '另一个研究核对正在运行，请等待结束后重试。' : 'Another study inspection is running; wait for it to finish and retry.'
            : lang === 'zh' ? '核对工作进程异常或已取消，请重试；没有调用模型或改写工作区。' : 'The inspection worker failed or was cancelled; retry. No model was called and no workspace was changed.';
          const incomplete = !request.complete; if (incomplete) response.shouldKeepAlive = false;
          response.writeHead(503, { ...JSON_HEADERS, ...(incomplete ? { Connection: 'close' } : {}) });
          response.end(JSON.stringify({ error: code, message }));
        } else writeJsonError(response, code === 'knowledge_study_capacity_exceeded' ? 413 : 400, code);
      } finally { lease?.release(); response.off('close', cancel); liveStreams.delete(cancel); }
    },
  }]);
}
