const RFC3339_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i;

/**
 * Normalize an absolute RFC 3339 timestamp without accepting JavaScript's
 * environment-dependent date shortcuts or calendar rollover.
 */
export function normalizeRfc3339Timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  const match = RFC3339_TIMESTAMP_RE.exec(candidate);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 60
  ) return undefined;

  const offset = match[8].toUpperCase();
  // RFC 3339 reserves -00:00 for an unknown local offset. It is syntactically
  // valid but does not identify an absolute instant, so measurement code must
  // not silently reinterpret it as UTC.
  if (offset === '-00:00') return undefined;
  if (offset !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
  }

  const parseableCandidate = second === 60
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:59${match[7] ? `.${match[7]}` : ''}${offset}`
    : candidate;
  const parsedMs = Date.parse(parseableCandidate);
  if (second === 60) {
    const beforeLeap = new Date(parsedMs);
    if (
      beforeLeap.getUTCHours() !== 23
      || beforeLeap.getUTCMinutes() !== 59
      || beforeLeap.getUTCSeconds() !== 59
      || beforeLeap.getUTCDate()
        !== daysInMonth(beforeLeap.getUTCFullYear(), beforeLeap.getUTCMonth() + 1)
    ) return undefined;
  }
  const epochMs = second === 60 ? parsedMs + 1000 : parsedMs;
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : undefined;
}

export function isRfc3339Timestamp(value: unknown): value is string {
  return normalizeRfc3339Timestamp(value) !== undefined;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
