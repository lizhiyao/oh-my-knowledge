import type { SourceResolution } from '../../../knowledge/sources.js';
import type { SourceViewResolution } from '../../view-models/knowledge/knowledge-candidates.js';

/** Routine reader projections omit raw envelopes; explicit source/preview readback retains complete originals. */
export function sourceView(source: SourceResolution): SourceViewResolution {
  if (source.status !== 'available') return source;
  const { rawUnits, ...snapshot } = source.snapshot; void rawUnits;
  return { status: 'available', snapshot };
}
