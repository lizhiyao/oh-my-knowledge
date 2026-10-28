import { executeLocalExtractionStudy, unsupportedFrozenTypedGeneration } from '../../knowledge/application/study-local.js';
import { createExtractionArchiveProducer } from '../../executors/archive.js';
import { runWorkerJob } from '../../shared/worker-job.js';
import type { ExecutorArchiveProducer } from '../../executors/contracts/archive.js';
import type { LocalExtractionStudyRequest } from './knowledge-study.js';

void runWorkerJob((input, context) => {
  const { environment, ...request } = input as LocalExtractionStudyRequest;
  if (request.command === 'run') return unsupportedFrozenTypedGeneration();
  const concrete = createExtractionArchiveProducer(Object.freeze({ ...environment }));
  const producer: ExecutorArchiveProducer = { ...concrete, configure(executor, actual, beforeDispatch) {
    return concrete.configure(executor, actual, () => {
      context.checkpoint(); beforeDispatch?.(); context.checkpoint();
    });
  } };
  return executeLocalExtractionStudy({ ...request, producer, signal: context.signal });
});
