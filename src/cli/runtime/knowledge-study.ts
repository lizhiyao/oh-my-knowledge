// Internal repository delivery client. Portable input cannot choose a worker or producer.
import { createWorkerJobService } from '../../shared/worker-job.js';
import type { executeLocalExtractionStudy as executeStudyApplication } from '../../knowledge/application/study-local.js';

export type LocalExtractionStudyRequest = Omit<Parameters<typeof executeStudyApplication>[0], 'producer' | 'signal'> & {
  environment: NodeJS.ProcessEnv;
};
const jobs = createWorkerJobService(new URL('./knowledge-study-worker.js', import.meta.url), 'cooperative');

/** All prepare/run/report CPU work and the concrete producer live in the fixed delivery worker. */
export async function executeLocalExtractionStudy(input: LocalExtractionStudyRequest & { signal?: AbortSignal }) {
  const { signal, ...request } = input, lease = jobs.reserve(signal);
  try { return await lease.run<Awaited<ReturnType<typeof executeStudyApplication>>>(request); }
  finally { lease.release(); }
}
