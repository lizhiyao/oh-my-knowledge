/**
 * 观察收件箱子域入口：只留类型与转口，实现分别住在 report-primitives／report-building／report-store／report-presentation。
 */
import type {
  BuildObservationInboxReportOptions,
  ObservationCaptureCoverage,
  ObservationEvidence,
  ObservationInboxItem,
  ObservationInboxReport,
  ObservationMessageRef,
  ObservationMessageWindow,
  ObservationSessionTimeRange,
  ObservationSeverityReasonCode,
  ObservationSignalSubtype,
  ObservationSignalType,
  ObservationSkillRollup,
} from '../contracts/inbox.js';
import type { TraceSourceKind } from '../contracts/trace.js';
import {
  normalizeObservationKeyInput,
} from './identity.js';
import {
  DEFAULT_GLOBAL_OBSERVATIONS_DIR,
  DEFAULT_OBSERVATIONS_DIR,
  DEFAULT_PROJECT_OBSERVATIONS_DIR,
  observationDraftsDir,
  resolveObservationsDir,
} from './paths.js';

export {
  DEFAULT_GLOBAL_OBSERVATIONS_DIR,
  DEFAULT_OBSERVATIONS_DIR,
  DEFAULT_PROJECT_OBSERVATIONS_DIR,
  observationDraftsDir,
  resolveObservationsDir,
  normalizeObservationKeyInput,
};

export type {
  BuildObservationInboxReportOptions,
  ObservationCaptureCoverage,
  ObservationEvidence,
  ObservationInboxItem,
  ObservationInboxReport,
  ObservationMessageRef,
  ObservationMessageWindow,
  ObservationSessionTimeRange,
  ObservationSeverityReasonCode,
  ObservationSignalSubtype,
  ObservationSignalType,
  ObservationSkillRollup,
  TraceSourceKind,
};

export {
  type PersistedObservationInboxReport,
} from './report-primitives.js';
export {
  aggregateInboxItems,
  buildObservationInboxReport,
  buildObservationInboxReportFromTraceSessions,
  compactObservationInboxReport,
  inferObservationSourceKind,
} from './report-building.js';
export {
  findObservationInboxItem,
  loadLatestObservationInboxReports,
  loadObservationInboxReports,
  queryObservationInbox,
  saveObservationInboxReport,
  selectExploreInboxItems,
} from './report-store.js';
export {
  formatObservationShow,
  summarizeObservationInboxBySkill,
} from './report-presentation.js';
