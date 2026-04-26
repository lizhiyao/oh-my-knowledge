import type { EvaluationJob } from './eval.js';
import type { Report } from './report.js';

export interface ReportStore {
  list(): Promise<Report[]>;
  get(id: string): Promise<Report | null>;
  save(id: string, report: Report): Promise<void>;
  update(id: string, mutator: (report: Report) => void): Promise<Report | null>;
  remove(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  findByVariant(variantName: string): Promise<Report[]>;
  findByArtifactHash(hash: string): Promise<Report[]>;
}

export interface JobStore {
  list(): Promise<EvaluationJob[]>;
  get(id: string): Promise<EvaluationJob | null>;
  save(id: string, job: EvaluationJob): Promise<void>;
  update(id: string, mutator: (job: EvaluationJob) => EvaluationJob): Promise<EvaluationJob | null>;
  remove(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
}
