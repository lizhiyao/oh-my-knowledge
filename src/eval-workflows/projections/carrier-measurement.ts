import type { CarrierKnowledgeRef } from '../../knowledge-artifacts/authoring/library-contracts.js';
import type { CoreCliRunOutcome } from './contracts.js';

export type CarrierControl = { sourceKind: 'version'; artifactId: string; version: number } | { sourceKind: 'local'; path: string };
export interface CarrierMeasurementInput {
  workspace: string; artifactId: string; version: number; control: CarrierControl;
  samples: string; executor: 'codex' | 'claude' | 'openai-api' | 'anthropic-api'; model: string;
  judge: boolean; judgeModel: string;
}
export interface CarrierMeasurementPlan {
  measurementId: string; expiresAt: string; treatment: { artifactId: string; revisionId: string; version: number; name: string; contentHash: string; knowledgeRefs: CarrierKnowledgeRef[]; content: string };
  control: { label: string; path: string; contentHash: string; content: string }; samplesPath: string; samples: { sampleId: string; input: string; provenance: string; criteria: string }[];
  executor: string; model: string; judgeModel: string | null; trials: number;
  scoringModels: string[]; executionCoordinates: number; evaluatorCount: number; runContractDigest: string;
}
export interface CarrierMeasurementRecord {
  measurementId: string; createdAt: string; plan: { treatment: Omit<CarrierMeasurementPlan['treatment'], 'content'>; control: Omit<CarrierMeasurementPlan['control'], 'content'>; model: string; executor: string; judgeModel: string | null; trials: number; sampleCount: number; runContractDigest: string };
  status: 'prepared' | 'running' | 'finished' | 'failed' | 'cancelled' | 'interrupted';
  outcome?: CoreCliRunOutcome;
  errorCode?: 'measurement_conflict' | 'measurement_request_failed' | 'measurement_persistence_failed';
}
