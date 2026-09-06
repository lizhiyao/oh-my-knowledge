import { createHash } from 'node:crypto';
import type { ResourceClassification } from '../input-compilation/index.js';
import type { Sample } from '../inputs/contracts/sample.js';

const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
const TRAILING_PUNCTUATION = /[.,;!?，。；！？、：]+$/u;
const MAX_RESOLVABLE_URLS = 64;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 8 * 1024 * 1024;

const PLACEHOLDER_HOSTS = new Set([
  'example',
  'example.com',
  'example.net',
  'example.org',
  'invalid',
  'localhost',
  'test',
]);

export type SampleContentTransportKind = 'http' | 'mcp';

export interface SampleContentResolution {
  readonly content: string;
  readonly mediaType: string;
  readonly transportKind: SampleContentTransportKind;
  readonly classification: Extract<ResourceClassification, 'public' | 'sensitive'>;
}

export interface SampleContentResolverSession {
  resolve(url: string): Promise<SampleContentResolution>;
  close(): Promise<void>;
}

export interface ResolvedSampleContentRecord extends SampleContentResolution {
  readonly sourceUrlDigest: `sha256:${string}`;
  readonly contentDigest: `sha256:${string}`;
  readonly sampleIds: readonly string[];
  readonly fields: readonly ('prompt' | 'context')[];
}

export interface ResolvedSampleContents {
  readonly samples: readonly Sample[];
  readonly contents: readonly ResolvedSampleContentRecord[];
}

export class SampleContentResolutionError extends Error {
  readonly sourceUrlDigest?: `sha256:${string}`;
  readonly sourceLabel?: string;
  readonly sampleIds?: readonly string[];

  constructor(input: {
    readonly message: string;
    readonly sourceUrlDigest?: `sha256:${string}`;
    readonly sourceLabel?: string;
    readonly sampleIds?: readonly string[];
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'SampleContentResolutionError';
    this.sourceUrlDigest = input.sourceUrlDigest;
    this.sourceLabel = input.sourceLabel;
    this.sampleIds = input.sampleIds;
  }
}

interface UrlOccurrence {
  readonly rawUrl: string;
  readonly fetchUrl: string;
  readonly sampleId: string;
  readonly sampleIndex: number;
  readonly field: 'prompt' | 'context';
}

interface UrlGroup {
  readonly fetchUrl: string;
  readonly occurrences: readonly UrlOccurrence[];
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stripUnbalancedClosingPunctuation(value: string): string {
  let result = value.replace(TRAILING_PUNCTUATION, '');
  const pairs = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const;
  for (const [open, close] of pairs) {
    while (result.endsWith(close)
      && result.split(close).length > result.split(open).length) {
      result = result.slice(0, -1);
    }
  }
  return result;
}

function normalizedHttpUrl(rawUrl: string): string | undefined {
  const candidate = stripUnbalancedClosingPunctuation(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SampleContentResolutionError({
      message: 'Sample URL 不得在 authority 中携带用户名或密码。',
      sourceUrlDigest: sha256(candidate),
      sourceLabel: safeUrlLabel(candidate),
    });
  }
  parsed.hash = '';
  return parsed.href;
}

export function isPlaceholderSampleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (PLACEHOLDER_HOSTS.has(hostname)) return true;
  return hostname.endsWith('.example.com')
    || hostname.endsWith('.example.net')
    || hostname.endsWith('.example.org')
    || hostname.endsWith('.example')
    || hostname.endsWith('.invalid')
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.test');
}

export function safeUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port === '' ? '' : `:${parsed.port}`;
    return `${parsed.protocol}//${parsed.hostname}${port}`;
  } catch {
    return '<invalid-url>';
  }
}

function occurrences(samples: readonly Readonly<Sample>[]): readonly UrlOccurrence[] {
  const found: UrlOccurrence[] = [];
  for (const [sampleIndex, sample] of samples.entries()) {
    for (const field of ['prompt', 'context'] as const) {
      const text = sample[field];
      if (typeof text !== 'string' || text === '') continue;
      for (const match of text.matchAll(URL_PATTERN)) {
        const rawUrl = stripUnbalancedClosingPunctuation(match[0]);
        const fetchUrl = normalizedHttpUrl(rawUrl);
        if (fetchUrl === undefined || isPlaceholderSampleUrl(fetchUrl)) continue;
        found.push({ rawUrl, fetchUrl, sampleId: sample.sample_id, sampleIndex, field });
      }
    }
  }
  return found;
}

function groups(samples: readonly Readonly<Sample>[]): readonly UrlGroup[] {
  const byUrl = new Map<string, UrlOccurrence[]>();
  for (const occurrence of occurrences(samples)) {
    const current = byUrl.get(occurrence.fetchUrl) ?? [];
    current.push(occurrence);
    byUrl.set(occurrence.fetchUrl, current);
  }
  if (byUrl.size > MAX_RESOLVABLE_URLS) {
    throw new SampleContentResolutionError({
      message: `单个 sample set 最多解析 ${MAX_RESOLVABLE_URLS} 个不同 URL。`,
    });
  }
  return [...byUrl.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fetchUrl, groupedOccurrences]) => ({
      fetchUrl,
      occurrences: groupedOccurrences,
    }));
}

export function hasResolvableSampleUrls(samples: readonly Readonly<Sample>[]): boolean {
  return occurrences(samples).length > 0;
}

function normalizedContent(content: string, sourceUrl: string): string {
  const normalized = content.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n').trim();
  const size = Buffer.byteLength(normalized);
  if (normalized === '') {
    throw new SampleContentResolutionError({
      message: 'Sample URL 解析结果为空。',
      sourceUrlDigest: sha256(sourceUrl),
      sourceLabel: safeUrlLabel(sourceUrl),
    });
  }
  if (size > MAX_CONTENT_BYTES) {
    throw new SampleContentResolutionError({
      message: `Sample URL 解析内容超过 ${MAX_CONTENT_BYTES} bytes 上限。`,
      sourceUrlDigest: sha256(sourceUrl),
      sourceLabel: safeUrlLabel(sourceUrl),
    });
  }
  return normalized;
}

function replacement(rawUrl: string, content: string): string {
  return `${rawUrl}\n\n--- OMK resolved content ---\n${content}\n--- end OMK resolved content ---`;
}

function replaceResolvedUrlOccurrences(
  text: string,
  contentsByFetchUrl: ReadonlyMap<string, string>,
): string {
  return text.replace(URL_PATTERN, (matched) => {
    const rawUrl = stripUnbalancedClosingPunctuation(matched);
    const trailing = matched.slice(rawUrl.length);
    const fetchUrl = normalizedHttpUrl(rawUrl);
    const content = fetchUrl === undefined ? undefined : contentsByFetchUrl.get(fetchUrl);
    return content === undefined ? matched : `${replacement(rawUrl, content)}${trailing}`;
  });
}

/**
 * Resolves external sample content before Dataset compilation. The returned samples are clones;
 * source DTOs are never mutated. Resolver transport and source locators stay outside canonical
 * measurement identity, while the resolved bytes are inlined into the Dataset input.
 */
export async function resolveSampleContents(
  samples: readonly Readonly<Sample>[],
  session: SampleContentResolverSession,
): Promise<ResolvedSampleContents> {
  const urlGroups = groups(samples);
  if (urlGroups.length === 0) return { samples: samples.map((sample) => structuredClone(sample)), contents: [] };

  const settled = await Promise.allSettled(urlGroups.map(async (group) => {
    const sampleIds = [...new Set(group.occurrences.map((item) => item.sampleId))].sort();
    let result: SampleContentResolution;
    try {
      result = await session.resolve(group.fetchUrl);
    } catch (cause) {
      if (cause instanceof SampleContentResolutionError) {
        throw new SampleContentResolutionError({
          message: cause.message,
          sourceUrlDigest: cause.sourceUrlDigest ?? sha256(group.fetchUrl),
          sourceLabel: cause.sourceLabel ?? safeUrlLabel(group.fetchUrl),
          sampleIds,
          cause,
        });
      }
      throw new SampleContentResolutionError({
        message: 'Sample URL 无法解析；不会退回原始 URL 继续测量。',
        sourceUrlDigest: sha256(group.fetchUrl),
        sourceLabel: safeUrlLabel(group.fetchUrl),
        sampleIds,
        cause,
      });
    }
    const content = normalizedContent(result.content, group.fetchUrl);
    return {
      group,
      result: { ...result, content },
      contentSize: Buffer.byteLength(content),
      sampleIds,
    };
  }));
  const firstFailure = settled.find(
    (item): item is PromiseRejectedResult => item.status === 'rejected',
  );
  if (firstFailure !== undefined) throw firstFailure.reason;
  const resolved = settled.map((item) => (
    item as PromiseFulfilledResult<{
      group: UrlGroup;
      result: SampleContentResolution & { content: string };
      contentSize: number;
      sampleIds: string[];
    }>
  ).value);

  const totalSize = resolved.reduce(
    (sum, item) => sum + item.contentSize * item.group.occurrences.length,
    0,
  );
  if (totalSize > MAX_TOTAL_CONTENT_BYTES) {
    throw new SampleContentResolutionError({
      message: `单个 sample set 内联后的外部解析内容总量超过 ${MAX_TOTAL_CONTENT_BYTES} bytes 上限。`,
    });
  }

  const cloned = samples.map((sample) => structuredClone(sample) as Sample);
  const contentsByFetchUrl = new Map(resolved.map((item) => [
    item.group.fetchUrl,
    item.result.content,
  ]));
  for (const sample of cloned) {
    for (const field of ['prompt', 'context'] as const) {
      const current = sample[field];
      if (typeof current !== 'string') continue;
      sample[field] = replaceResolvedUrlOccurrences(current, contentsByFetchUrl);
    }
  }
  const records: ResolvedSampleContentRecord[] = [];
  for (const item of resolved) {
    records.push({
      ...item.result,
      sourceUrlDigest: sha256(item.group.fetchUrl),
      contentDigest: sha256(item.result.content),
      sampleIds: item.sampleIds,
      fields: [...new Set(item.group.occurrences.map((entry) => entry.field))].sort(),
    });
  }

  return { samples: cloned, contents: records };
}
