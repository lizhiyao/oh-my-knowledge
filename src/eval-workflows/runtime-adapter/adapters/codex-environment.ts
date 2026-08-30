import { z } from 'zod';
import {
  JsonValueSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
} from '../../../evaluation-core/contracts/index.js';

export type CodexEnvironmentEntry = {
  readonly value: string;
  readonly identity:
    | { readonly identityKind: 'behavior'; readonly value: JsonValue }
    | { readonly identityKind: 'credential' }
    | { readonly identityKind: 'effect-locator' };
};

export interface CapturedCodexEnvironment {
  readonly values: Readonly<Record<string, string>>;
  readonly identity: JsonValue[];
}

const EnvironmentSchema = z.record(
  z.string().min(1).refine((value) => !value.includes('\0')),
  z.object({
    value: z.string().refine((value) => !value.includes('\0')),
    identity: z.discriminatedUnion('identityKind', [
      z.object({
        identityKind: z.literal('behavior'),
        value: JsonValueSchema,
      }).strict(),
      z.object({ identityKind: z.literal('credential') }).strict(),
      z.object({ identityKind: z.literal('effect-locator') }).strict(),
    ]),
  }).strict(),
);

export function captureCodexEnvironment(
  input: Readonly<Record<string, CodexEnvironmentEntry>> | undefined,
): CapturedCodexEnvironment {
  const environment = EnvironmentSchema.parse(structuredClone(input ?? {}));
  const entries = Object.entries(environment).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return Object.freeze({
    values: Object.freeze(Object.fromEntries(entries.map(([key, entry]) => [
      key,
      entry.value,
    ]))),
    identity: deepFreezeCanonicalJson(entries.map(([key, entry]) => ({
      keyDigest: digestCanonicalJson(key),
      identityKind: entry.identity.identityKind,
      ...(entry.identity.identityKind === 'behavior' ? { value: entry.identity.value } : {}),
    }))),
  });
}
