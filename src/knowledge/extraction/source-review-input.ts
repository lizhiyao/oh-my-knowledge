import { createHash } from 'node:crypto';
import { SourceSnapshotSchema, sourceSetPreimage, type SourceSnapshot } from '../sources.js';
import { SourceReviewManifestSchema, type SourceReviewManifest } from '../source-review.js';
import { canonicalJson } from '../store.js';
import { generationSourceInput } from './source-input.js';

/** Separate identity: the default two-stage input remains unchanged until workflow4 is integrated. */
export const SOURCE_REVIEW_INPUT_VERSION = 'knowledge-source-generation-input/v2' as const;
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
