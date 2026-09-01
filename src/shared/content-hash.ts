import { createHash } from 'node:crypto';

export function shortContentHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
