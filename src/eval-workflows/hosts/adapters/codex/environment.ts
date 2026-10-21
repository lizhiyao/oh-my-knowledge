import { captureClassifiedEnvironment, type ClassifiedEnvironmentEntry } from '../shared/classified-environment.js';

export type CodexEnvironmentEntry = ClassifiedEnvironmentEntry;
export const captureCodexEnvironment = captureClassifiedEnvironment;
