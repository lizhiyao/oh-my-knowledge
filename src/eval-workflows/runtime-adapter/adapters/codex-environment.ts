import {
  captureClassifiedEnvironment,
  type CapturedClassifiedEnvironment,
  type ClassifiedEnvironmentEntry,
} from './classified-environment.js';

export type CodexEnvironmentEntry = ClassifiedEnvironmentEntry;
export type CapturedCodexEnvironment = CapturedClassifiedEnvironment;
export const captureCodexEnvironment = captureClassifiedEnvironment;
