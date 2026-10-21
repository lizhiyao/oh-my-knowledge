export type ExtractionStudyInspectionCode = 'knowledge_study_input_invalid' | 'knowledge_study_capacity_exceeded'
  | 'knowledge_study_host_mismatch' | 'knowledge_study_evidence_invalid' | 'knowledge_study_busy' | 'knowledge_study_unavailable';
export class ExtractionStudyInspectionError extends Error {
  constructor(readonly code: ExtractionStudyInspectionCode) { super(code); this.name = 'ExtractionStudyInspectionError'; }
}
export type ExtractionStudyFileLabel = '--evidence' | '--author-review' | '--reference-review' | '--output-review' | '--judge-review';
export class ExtractionStudyFileError extends Error {
  constructor(readonly label: ExtractionStudyFileLabel) { super('knowledge_study_file_invalid'); this.name = 'ExtractionStudyFileError'; }
}
export class ExtractionStudyBodyError extends Error {
  constructor(readonly code: 'invalid_json_body' | 'json_body_not_object') { super(code); this.name = 'ExtractionStudyBodyError'; }
}
