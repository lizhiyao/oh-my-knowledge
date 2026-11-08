import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SourceSnapshotSchema, sourceSetPreimage, type SourceSnapshot } from '../sources/sources.js';
import { SourceReviewManifestSchema, type SourceReviewManifest } from '../sources/source-review.js';
import { canonicalJson } from '../store.js';
import { generationSourceInput } from './source-input.js';
import { buildSourcePassages, SOURCE_PASSAGE_POLICY, SourcePassagesSchema, sourcePassageText, assertSourcePassageInput } from './source-passages.js';

/** Canonical full-text manifest and coverage input; ledger delivery has its own identity. */
export const SOURCE_REVIEW_INPUT_VERSION = 'knowledge-source-generation-input/v2' as const;
export const SOURCE_LEDGER_INPUT_VERSION = 'knowledge-source-ledger-input/v1' as const;
export const SOURCE_REVIEW_REQUEST_CAPACITY_BYTES = 1024 * 1024;
export type SourceReviewUnit = SourceReviewManifest['units'][number] & { text: string };
export interface SourceReviewInput { manifest: SourceReviewManifest; units: SourceReviewUnit[] }
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const pointer = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
function fieldPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.length ? value.flatMap((item, index) => fieldPaths(item, `${path}/${index}`)) : [path];
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return keys.length ? keys.flatMap(key => fieldPaths((value as Record<string, unknown>)[key], `${path}/${pointer(key)}`)) : [path];
  }
  return [path];
}

/** Materialize all authorized portable input; raw envelopes, capture time and host bindings stay local. */
export function sourceReviewInput(sources: readonly SourceSnapshot[]): SourceReviewInput {
  const snapshots = sources.map(source => SourceSnapshotSchema.parse(source));
  const sourceSet = sourceSetPreimage(snapshots.map(source => ({ snapshotId: source.snapshotId, sourceVersion: source.sourceVersion })));
  if (sourceSet.sources.length !== snapshots.length) throw new Error('Duplicate source in source review input.');
  const ordered = sourceSet.sources.map(ref => snapshots.find(source => source.snapshotId === ref.snapshotId && source.sourceVersion === ref.sourceVersion)!);
  const sourceSetId = digest(canonicalJson(sourceSet));
  const portable = ordered.map(generationSourceInput);
  const sourceInputDigest = digest(canonicalJson({ inputVersion: SOURCE_REVIEW_INPUT_VERSION, sourceSetId, sources: portable }));
  const units: SourceReviewUnit[] = [];
  portable.forEach((source, ordinal) => {
    const sourceKey = `s${ordinal}`;
    const metadata = { source: source.source, excerpts: source.excerpts.map(({ text: _text, ...descriptor }) => {
      void _text; return descriptor;
    }), limitations: source.limitations };
    const text = canonicalJson(metadata);
    units.push({ unitKey: `${sourceKey}/metadata`, sourceKey, unitKind: 'source_metadata', evidenceRef: null,
      utf16Length: text.length, textDigest: digest(text), fieldPaths: fieldPaths(metadata).sort(), text });
    source.excerpts.forEach((excerpt, index) => units.push({ unitKey: `${sourceKey}/excerpt/${index}`, sourceKey,
      unitKind: 'excerpt_text', evidenceRef: excerpt.evidenceRef, utf16Length: excerpt.text.length, textDigest: digest(excerpt.text),
      fieldPaths: [`/excerpts/${index}/text`], text: excerpt.text }));
  });
  const manifest = SourceReviewManifestSchema.parse({ inputVersion: SOURCE_REVIEW_INPUT_VERSION, sourceSetId, sourceInputDigest,
    sources: ordered.map((source, ordinal) => ({ sourceKey: `s${ordinal}`, sourceRef: sourceSet.sources[ordinal], snapshotDigest: digest(canonicalJson(source)) })),
    units: units.map(({ text: _text, ...descriptor }) => { void _text; return descriptor; }) });
  if (Buffer.byteLength(canonicalJson({ manifest, units }), 'utf8') > SOURCE_REVIEW_REQUEST_CAPACITY_BYTES) {
    throw new Error('Source review input capacity_exceeded (1 MiB).');
  }
  return { manifest, units };
}

export function sourceLedgerPassages(input: SourceReviewInput) {
  return buildSourcePassages(input.units.map(unit => {
    const source = input.manifest.sources.find(source => source.sourceKey === unit.sourceKey);
    if (!source) throw new Error('Unknown source passage owner.');
    return { unitKey: unit.unitKey, text: unit.text, source: source.sourceRef };
  }), input.manifest.sources.map(source => source.sourceRef));
}

export function sourceLedgerInput(sources: readonly SourceSnapshot[]) {
  const input = sourceReviewInput(sources), index = sourceLedgerPassages(input);
  return { inputVersion: SOURCE_LEDGER_INPUT_VERSION, manifest: input.manifest,
    passagePolicy: SOURCE_PASSAGE_POLICY.policyVersion, passageIndexDigest: index.digest,
    units: input.units.map(({ text, ...unit }) => {
      void text; return { ...unit, passages: index.passages.get(unit.unitKey)! };
    }) };
}

const ledgerPassageInput = z.object({ inputVersion: z.literal(SOURCE_LEDGER_INPUT_VERSION), manifest: SourceReviewManifestSchema,
  passagePolicy: z.literal(SOURCE_PASSAGE_POLICY.policyVersion), passageIndexDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  units: z.array(SourceReviewManifestSchema.shape.units.element.extend({ passages: SourcePassagesSchema })) });

export function restoreSourceLedgerInput(value: unknown): SourceReviewInput {
  const input = ledgerPassageInput.parse(value);
  const units = input.units.map(({ passages, ...unit }) => ({ ...unit, text: sourcePassageText(passages) }));
  const restored = { manifest: input.manifest, units }, index = sourceLedgerPassages(restored);
  assertSourcePassageInput(index, input, input.units);
  return restored;
}
