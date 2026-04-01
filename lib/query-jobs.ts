import type { EvaluationJob, JobStore } from './types.js';

export async function queryJobList(jobStore: JobStore): Promise<EvaluationJob[]> {
  return jobStore.list();
}

export async function queryJob(jobStore: JobStore, id: string): Promise<EvaluationJob | null> {
  return jobStore.get(id);
}
