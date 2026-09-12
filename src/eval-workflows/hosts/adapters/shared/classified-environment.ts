import { z } from 'zod';
import {
  JsonValueSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
} from '../../../../eval-core/contracts/index.js';

export type ClassifiedEnvironmentEntry = {
  readonly value: string;
  /** Raises output/trace handling independently from the value's Runtime identity role. */
  readonly outputTaint?: 'sensitive' | 'secret';
  readonly identity:
    | { readonly identityKind: 'behavior'; readonly value: JsonValue }
    | { readonly identityKind: 'credential' }
    | { readonly identityKind: 'effect-locator' };
};

export interface CapturedClassifiedEnvironment {
  readonly values: Readonly<Record<string, string>>;
  readonly identity: JsonValue[];
  readonly outputClassification: 'public' | 'sensitive' | 'secret';
}

export function mergeOutputClassification<
  Left extends 'public' | 'sensitive' | 'secret' | 'gold',
  Right extends 'public' | 'sensitive' | 'secret' | 'gold',
>(left: Left, right: Right): Left | Right {
  const rank = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;
  return rank[left] >= rank[right] ? left : right;
}

const EnvironmentSchema = z.record(
  z.string().min(1).refine((value) => !value.includes('\0')),
  z.object({
    value: z.string().refine((value) => !value.includes('\0')),
    outputTaint: z.enum(['sensitive', 'secret']).optional(),
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

function identityClassificationFloor(
  identityKind: ClassifiedEnvironmentEntry['identity']['identityKind'],
): 'public' | 'sensitive' | 'secret' {
  if (identityKind === 'credential') return 'secret';
  if (identityKind === 'effect-locator') return 'sensitive';
  return 'public';
}

export function captureClassifiedEnvironment(
  input: Readonly<Record<string, ClassifiedEnvironmentEntry>> | undefined,
): CapturedClassifiedEnvironment {
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
      ...(entry.identity.identityKind === 'effect-locator'
        ? { valueDigest: digestCanonicalJson(entry.value) }
        : {}),
      ...(entry.outputTaint === undefined ? {} : { outputTaint: entry.outputTaint }),
    }))),
    outputClassification: entries.reduce<'public' | 'sensitive' | 'secret'>((result, [, entry]) => (
      // outputTaint raises handling for this value's role; it never lowers what that role already requires.
      mergeOutputClassification(
        result,
        mergeOutputClassification(
          identityClassificationFloor(entry.identity.identityKind),
          entry.outputTaint ?? 'public',
        ),
      )
    ), 'public'),
  });
}
