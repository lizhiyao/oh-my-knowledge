import { runWorkerJob } from '../../shared/worker-job.js';
import { inspectExtractionStudy } from './study-inspection.js';
import { ExtractionStudyBodyError, ExtractionStudyFileError, ExtractionStudyInspectionError } from '../adapters/study-inspection-errors.js';
import { parseExtractionStudyInspectionBody, readExtractionStudyInspectionFiles } from '../adapters/study-inspection-input.js';
import type { ExtractionStudyInspectionJob } from './study-inspection-service.js';

void runWorkerJob((input, context) => {
  try {
    const job = input as ExtractionStudyInspectionJob;
    const request = job.inputKind === 'files' ? readExtractionStudyInspectionFiles(job.files)
      : parseExtractionStudyInspectionBody(new Uint8Array(job.bytes));
    context.checkpoint();
    return { resultKind: 'inspected', value: inspectExtractionStudy(request) };
  } catch (error) {
    if (error instanceof ExtractionStudyInspectionError) return { resultKind: 'inspection_error', code: error.code };
    if (error instanceof ExtractionStudyFileError) return { resultKind: 'file_error', label: error.label };
    if (error instanceof ExtractionStudyBodyError) return { resultKind: 'body_error', code: error.code };
    throw error;
  }
});
