import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const REPORT_FILE_SUFFIX = '.report.json';
export const GRAPH_FILE_SUFFIX = '.graph.json';
export const CARD_FILE_SUFFIX = '.card.md';

export function safeArtifactFileStem(id: string): string {
  return id.replaceAll(/[/\\:*?"<>|]/g, '_');
}

export function reportFileName(stem: string): string {
  return `${safeArtifactFileStem(stem)}${REPORT_FILE_SUFFIX}`;
}

export function reportFilePath(dir: string, stem: string): string {
  return join(dir, reportFileName(stem));
}

export function reportFileStem(fileName: string): string | null {
  return fileName.endsWith(REPORT_FILE_SUFFIX)
    ? fileName.slice(0, -REPORT_FILE_SUFFIX.length)
    : null;
}

export function isReportFileName(fileName: string): boolean {
  return reportFileStem(fileName) !== null;
}

export function graphFileName(stem: string): string {
  return `${safeArtifactFileStem(stem)}${GRAPH_FILE_SUFFIX}`;
}

export function cardFileName(stem: string): string {
  return `${safeArtifactFileStem(stem)}${CARD_FILE_SUFFIX}`;
}

export function runTimestamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function randomRunToken(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function runFileSuffix(): string {
  return `${runTimestamp()}-${randomRunToken()}`;
}

export function stripDomainPrefix(id: string, domain: string): string {
  const safeId = safeArtifactFileStem(id);
  const prefix = `${domain}-`;
  return safeId.startsWith(prefix) ? safeId.slice(prefix.length) : safeId;
}

export function doctorReportFileStem(skillName: string, reportId: string): string {
  const reportSuffix = reportId.startsWith('doctor-')
    ? reportId.slice('doctor-'.length)
    : reportId;
  return [
    collisionResistantFileComponent(skillName),
    collisionResistantFileComponent(reportSuffix),
  ].join('-');
}

function collisionResistantFileComponent(value: string): string {
  const safe = safeArtifactFileStem(value);
  if (safe === value) return safe;
  const fingerprint = createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 12);
  return `${safe}-${fingerprint}`;
}
