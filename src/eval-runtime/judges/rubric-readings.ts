/** Pure response decoding shared by the evaluator and its in-memory debugger. */
export type RubricReading =
  | Readonly<{ metricId: string; observationStatus: 'observed'; value: number; reason: string; reasoning?: string }>
  | Readonly<{ metricId: string; observationStatus: 'invalid'; reasonCode: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeRubricReadings(metricIds: readonly string[], output: string): RubricReading[] {
  const invalid = (metricId: string, reasonCode: string): RubricReading => ({ metricId, observationStatus: 'invalid', reasonCode });
  const invalidAll = (reason: string) => metricIds.map((metricId) => invalid(metricId, reason));
  const json = output.trim();
  if (!json.includes('{')) return invalidAll('judge-response-non-json');
  let value: unknown;
  try { value = JSON.parse(json); } catch { return invalidAll('judge-response-malformed-json'); }
  if (!isRecord(value) || Object.keys(value).length !== 1 || Object.keys(value)[0] !== 'scores' || !Array.isArray(value.scores)) {
    return invalidAll('judge-response-metric-set-invalid');
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of value.scores) {
    if (!isRecord(item) || typeof item.metricId !== 'string' || byId.has(item.metricId)) {
      return invalidAll('judge-response-metric-set-invalid');
    }
    byId.set(item.metricId, item);
  }
  if (byId.size !== metricIds.length || metricIds.some((metricId) => !byId.has(metricId))) {
    return invalidAll('judge-response-metric-set-invalid');
  }
  return metricIds.map((metricId) => {
    const reading = byId.get(metricId)!;
    if (typeof reading.score !== 'number' || !Number.isInteger(reading.score)) {
      return invalid(metricId, 'judge-score-malformed');
    }
    if (reading.score < 1 || reading.score > 5) return invalid(metricId, 'judge-score-out-of-range');
    if (typeof reading.reason !== 'string' || reading.reason.trim() === '') return invalid(metricId, 'judge-reason-missing');
    return {
      metricId, observationStatus: 'observed', value: reading.score, reason: reading.reason,
      ...(typeof reading.reasoning === 'string' && reading.reasoning.trim() !== '' ? { reasoning: reading.reasoning } : {}),
    };
  });
}
