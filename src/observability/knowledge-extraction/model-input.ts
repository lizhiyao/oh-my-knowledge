import type { EvidenceWindow } from './evidence.js';
import { EXTRACTION_PROMPT } from './prompt.js';

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

/** Validate only a new call; saved request receipts remain readable at their original identity. */
export function assertExtractionInputCapacity(input: string): void {
  if (Buffer.byteLength(EXTRACTION_PROMPT, 'utf8') + Buffer.byteLength(input, 'utf8') > EXTRACTION_INPUT_MAX_BYTES) {
    throw new ExtractionInputCapacityError();
  }
}
