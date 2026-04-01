import type { EvaluationJob, JobStore } from './types.js';

export interface JobQuery {
  status?: string;
  reportId?: string;
  project?: string;
  owner?: string;
  tag?: string;
  limit?: number;
}

export async function queryJobList(jobStore: JobStore, query: JobQuery = {}): Promise<EvaluationJob[]> {
  let jobs = await jobStore.list();

  if (query.status) {
    jobs = jobs.filter((job) => job.status === query.status);
  }
  if (query.reportId) {
    jobs = jobs.filter((job) => job.resultReportId === query.reportId);
  }
  if (query.project) {
    jobs = jobs.filter((job) => job.request.project === query.project);
  }
  if (query.owner) {
    jobs = jobs.filter((job) => job.request.owner === query.owner);
  }
  if (query.tag) {
    const tag = query.tag;
    jobs = jobs.filter((job) => job.request.tags?.includes(tag));
  }
  if (typeof query.limit === 'number' && Number.isFinite(query.limit) && query.limit >= 0) {
    jobs = jobs.slice(0, query.limit);
  }

  return jobs;
}

export async function queryJob(jobStore: JobStore, id: string): Promise<EvaluationJob | null> {
  return jobStore.get(id);
}
