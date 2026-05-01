import type { EvaluationJob } from './eval.js';
import type { EvaluationReport, ReportDocument } from './report.js';

export interface ReportStore {
  list(): Promise<ReportDocument[]>;
  get(id: string): Promise<ReportDocument | null>;
  save(id: string, report: ReportDocument): Promise<void>;
  update(id: string, mutator: (report: ReportDocument) => void): Promise<ReportDocument | null>;
  remove(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  findByVariant(variantName: string): Promise<EvaluationReport[]>;
  findByArtifactHash(hash: string): Promise<EvaluationReport[]>;
}

export interface JobStore {
  list(): Promise<EvaluationJob[]>;
  get(id: string): Promise<EvaluationJob | null>;
  save(id: string, job: EvaluationJob): Promise<void>;
  update(id: string, mutator: (job: EvaluationJob) => EvaluationJob): Promise<EvaluationJob | null>;
  remove(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
}
