import { createWorkerJobService, WorkerJobError } from '../../shared/worker-job.js';
import { ExtractionStudyBodyError, ExtractionStudyFileError, ExtractionStudyInspectionError,
  type ExtractionStudyFileLabel, type ExtractionStudyInspectionCode } from '../adapters/study-inspection-errors.js';
import type { ExtractionStudyInspection } from './study-inspection.js';
import type { ExtractionStudyInspectionFiles } from '../adapters/study-inspection-input.js';

export type ExtractionStudyInspectionJob = { inputKind: 'bytes'; bytes: ArrayBuffer }
  | { inputKind: 'files'; files: ExtractionStudyInspectionFiles };
type InspectionResult = { resultKind: 'inspected'; value: ExtractionStudyInspection }
  | { resultKind: 'inspection_error'; code: ExtractionStudyInspectionCode }
  | { resultKind: 'file_error'; label: ExtractionStudyFileLabel }
  | { resultKind: 'body_error'; code: 'invalid_json_body' | 'json_body_not_object' };
const jobs = createWorkerJobService(new URL('./study-inspection-worker.js', import.meta.url), 'terminate');
function unavailable(error: unknown): never {
  if (error instanceof WorkerJobError) throw new ExtractionStudyInspectionError(error.code === 'worker_busy'
    ? 'knowledge_study_busy' : 'knowledge_study_unavailable');
  throw error;
}

/** Reserve before consuming an HTTP body: one bounded input, one worker, no queued private payloads. */
export function reserveExtractionStudyInspection(signal?: AbortSignal) {
  let lease: ReturnType<typeof jobs.reserve>;
  try { lease = jobs.reserve(signal); } catch (error) { return unavailable(error); }
  const inspect = async (input: ExtractionStudyInspectionJob) => {
    let result: InspectionResult;
    try { result = await lease.run<InspectionResult>(input, input.inputKind === 'bytes' ? [input.bytes] : []); }
    catch (error) { return unavailable(error); }
    if (result.resultKind === 'inspection_error') throw new ExtractionStudyInspectionError(result.code);
    if (result.resultKind === 'file_error') throw new ExtractionStudyFileError(result.label);
    if (result.resultKind === 'body_error') throw new ExtractionStudyBodyError(result.code);
    return result.value;
  };
  return { inspect, release: lease.release };
}

export async function inspectExtractionStudyFiles(files: ExtractionStudyInspectionFiles, signal?: AbortSignal) {
  const lease = reserveExtractionStudyInspection(signal);
  try { return await lease.inspect({ inputKind: 'files', files }); }
  finally { lease.release(); }
}
