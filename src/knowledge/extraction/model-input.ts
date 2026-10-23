import type { EvidenceWindow } from './evidence.js';
import { buildBodyOccurrenceGuide, type BodyOccurrenceGuideResult } from './body-occurrence-guide.js';
import { OCCURRENCE_GUIDED_EXTRACTION_PROMPT_VERSION } from './occurrence-guided-prompt.js';

/** Local request capacity, not a model context estimate or a spending limit. */
export const EXTRACTION_INPUT_MAX_BYTES = 1024 * 1024;

export class ExtractionInputCapacityError extends Error {
  constructor() {
    super('Extraction input exceeds the 1 MiB UTF-8 capacity (system rules and selected excerpts). Capture a smaller range with --start-record/--end-record, or select one turn and fewer messages in Studio. No model call was made.');
    this.name = 'ExtractionInputCapacityError';
  }
}

/** Keep native paths and raw envelopes local; never silently truncate grounding text. */
export function extractionModelInput(window: Pick<EvidenceWindow, 'excerpts' | 'limitations'>): string {
  return JSON.stringify({ excerpts: window.excerpts, limitations: window.limitations });
}

export class ExtractionOccurrenceGuideError extends Error {
  readonly reason: Extract<BodyOccurrenceGuideResult, { status: 'refused' }>['reason'];
  constructor(result: Extract<BodyOccurrenceGuideResult, { status: 'refused' }>) {
    super(`Occurrence guide refused: ${result.reason} (${result.phase}). Capture a smaller source window. No model call was made.`);
    this.name = 'ExtractionOccurrenceGuideError';
    this.reason = result.reason;
  }
}

/** Fixed task input shared by dispatch, admission, recovery and E-to-K binding. */
export function extractionTaskInput(window: Pick<EvidenceWindow, 'excerpts' | 'limitations'>, promptVersion: string): string {
  if (promptVersion !== OCCURRENCE_GUIDED_EXTRACTION_PROMPT_VERSION) return extractionModelInput(window);
  const result = buildBodyOccurrenceGuide(window.excerpts);
  if (result.status === 'refused') throw new ExtractionOccurrenceGuideError(result);
  return JSON.stringify({ excerpts: window.excerpts, limitations: window.limitations, occurrenceGuide: result.guide });
}

/** Validate only a new call; saved request receipts remain readable at their original identity. */
export function assertExtractionInputCapacity(input: string, system: string): void {
  if (Buffer.byteLength(system, 'utf8') + Buffer.byteLength(input, 'utf8') > EXTRACTION_INPUT_MAX_BYTES) {
    throw new ExtractionInputCapacityError();
  }
}
