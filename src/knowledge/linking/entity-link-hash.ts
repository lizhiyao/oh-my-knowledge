import { createHash } from 'node:crypto';
import { canonicalJson } from '../store.js';
import type { EntityLinkHash } from '../entities/links.js';

/** Host-owned hash; knowledge owns canonical input and deterministic validation. */
export const entityLinkDigest: EntityLinkHash = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
