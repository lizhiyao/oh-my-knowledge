import { createHash } from 'node:crypto';

export function shortContentHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * 全长度内容摘要。`sha256:` 前缀与 Core 的 `Sha256Digest` 形状一致，
 * 但 shared 是跨领域叶子，不反向依赖 Core 的类型。
 */
export function contentSha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
