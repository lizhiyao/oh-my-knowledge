import { randomRunToken, runTimestamp } from '../measurement-artifacts/file-names.js';

function runIdSuffix(): string {
  return `${runTimestamp()}-${randomRunToken()}`;
}

function safeRunSubject(subject: string): string {
  const sanitized = subject
    .replaceAll(/[\\/:]/g, '-')
    .replaceAll(/[^a-zA-Z0-9._@-]/g, '_')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'run';
}

function primaryRunSubject(subjects: readonly string[]): string {
  const nonBaseline = subjects.filter((subject) => subject !== 'baseline');
  return nonBaseline.at(-1) ?? subjects.at(-1) ?? 'run';
}

/** Host-owned label allocation; it never participates in a measurement digest. */
export function generateRunId(subjects: readonly string[]): string {
  return `${safeRunSubject(primaryRunSubject(subjects))}-${runIdSuffix()}`;
}
