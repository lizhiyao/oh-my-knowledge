import type { ObservationInboxReport, ObservationSessionTimeRange } from '../contracts/inbox.js';
import { durationMsBetween } from '../../shared/time.js';

export function buildOverallSessionTimeRange(
  ranges: readonly Pick<ObservationSessionTimeRange, 'startTimestamp' | 'endTimestamp'>[] = [],
): NonNullable<ObservationInboxReport['meta']['sessionTimeRange']> {
  const starts = ranges.map((range) => range.startTimestamp).filter((value): value is string => Boolean(value));
  const ends = ranges.map((range) => range.endTimestamp).filter((value): value is string => Boolean(value));
  if (starts.length === 0 || ends.length === 0) return { from: '', to: '' };
  const from = starts.reduce((min, value) => value < min ? value : min, starts[0]);
  const to = ends.reduce((max, value) => value > max ? value : max, ends[0]);
  return { from, to, durationMs: durationMsBetween(from, to) };
}
