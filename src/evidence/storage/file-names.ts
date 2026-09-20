import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const REPORT_FILE_SUFFIX = '.report.json';
export const GRAPH_FILE_SUFFIX = '.graph.json';
export const CARD_FILE_SUFFIX = '.card.md';

export function safeArtifactFileStem(id: string): string {
  return id.replaceAll(/[/\\:*?"<>|]/g, '_');
}

/** 产物文件 stem 的唯一合法性判据：非空且不含需要替换的字符。
 *  写侧／读侧／删除侧共用同一条规则；任何一处单独放宽，卡片就会指向索引目录之外。 */
export function isCanonicalArtifactFileStem(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && safeArtifactFileStem(value) === value;
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
  if (isCanonicalArtifactFileStem(value)) return value;
  const safe = safeArtifactFileStem(value);
  const fingerprint = createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 12);
  return `${safe}-${fingerprint}`;
}
