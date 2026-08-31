import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ContentClassificationSchema,
  ContentDescriptorSchema,
  JsonValueSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  type ContentDescriptor,
  type JsonValue,
} from '../../evaluation-core/contracts/index.js';
import type {
  ExecutionContent,
  ExecutionContentStoreRequest,
} from '../../evaluation-core/execution/index.js';
import type {
  EvaluationContent,
  EvaluationContentStoreRequest,
} from '../../evaluation-core/evaluation/index.js';
import {
  ensurePrivateDirectory,
  publishPrivateJsonExclusive,
} from './private-json-file.js';

const CONTENT_DOCUMENT_SCHEMA_VERSION = 'omk.host-content-document/v1' as const;
const CONTENT_URI_PREFIX = 'omk-content:';

const ContentDocumentSchema = z.object({
  schemaVersion: z.literal(CONTENT_DOCUMENT_SCHEMA_VERSION),
  contentDocumentKind: z.literal('evaluation-captured-content'),
  descriptor: ContentDescriptorSchema,
  classification: ContentClassificationSchema,
  value: JsonValueSchema,
  contentDocumentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

type ContentDocument = z.infer<typeof ContentDocumentSchema>;

export type NodeCoreContentStore = {
  put(request: Readonly<
    ExecutionContentStoreRequest | EvaluationContentStoreRequest
  >): Promise<ContentDescriptor>;
  resolve(descriptor: Readonly<ContentDescriptor>): Promise<
    ExecutionContent | EvaluationContent
  >;
};

export type NodeCoreContentStoreErrorCode =
  | 'CORE_CONTENT_REQUEST_INVALID'
  | 'CORE_CONTENT_DESCRIPTOR_INVALID'
  | 'CORE_CONTENT_UNAVAILABLE'
  | 'CORE_CONTENT_DOCUMENT_INVALID'
  | 'CORE_CONTENT_IDENTITY_CONFLICT';

export class NodeCoreContentStoreError extends TypeError {
  readonly code: NodeCoreContentStoreErrorCode;

  constructor(code: NodeCoreContentStoreErrorCode, message: string) {
    super(message);
    this.name = 'NodeCoreContentStoreError';
    this.code = code;
  }
}

function fail(code: NodeCoreContentStoreErrorCode, message: string): never {
  throw new NodeCoreContentStoreError(code, message);
}

function contentKey(input: {
  digest: string;
  mediaType: string;
  classification: string;
}): string {
  return digestCanonicalJson({
    derivation: 'omk.host-content-key/v1',
    digest: input.digest,
    mediaType: input.mediaType,
    classification: input.classification,
  }).slice('sha256:'.length);
}

function contentFilePath(rootDir: string, key: string): string {
  return join(rootDir, 'content', `${key}.content.json`);
}

function parseContentKey(descriptor: ContentDescriptor): string {
  const uri = descriptor.uri;
  if (uri === undefined || !uri.startsWith(CONTENT_URI_PREFIX)) {
    fail(
      'CORE_CONTENT_DESCRIPTOR_INVALID',
      'Content descriptor is not owned by this host content store.',
    );
  }
  const key = uri.slice(CONTENT_URI_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(key)) {
    fail('CORE_CONTENT_DESCRIPTOR_INVALID', 'Content descriptor URI is invalid.');
  }
  return key;
}

function parseContentDocument(value: unknown): ContentDocument {
  const document = parseWireDocument(ContentDocumentSchema, value);
  const { contentDocumentDigest, ...payload } = document;
  if (digestCanonicalJson(payload) !== contentDocumentDigest) {
    fail(
      'CORE_CONTENT_DOCUMENT_INVALID',
      'Content document digest does not match its payload.',
    );
  }
  const canonical = canonicalizeJson(document.value);
  if (digestCanonicalJson(document.value) !== document.descriptor.digest
      || Buffer.byteLength(canonical, 'utf8') !== document.descriptor.size) {
    fail(
      'CORE_CONTENT_DOCUMENT_INVALID',
      'Content document does not match its descriptor.',
    );
  }
  const expectedKey = contentKey({
    digest: document.descriptor.digest,
    mediaType: document.descriptor.mediaType,
    classification: document.classification,
  });
  if (document.descriptor.uri !== `${CONTENT_URI_PREFIX}${expectedKey}`) {
    fail(
      'CORE_CONTENT_DOCUMENT_INVALID',
      'Content document URI does not match its identity.',
    );
  }
  return deepFreezeCanonicalJson(document);
}

export function createNodeCoreContentStore(rootDir: string): NodeCoreContentStore {
  async function resolve(
    rawDescriptor: Readonly<ContentDescriptor>,
  ): Promise<ExecutionContent | EvaluationContent> {
    let descriptor: ContentDescriptor;
    try {
      descriptor = parseWireDocument(ContentDescriptorSchema, rawDescriptor);
    } catch {
      fail('CORE_CONTENT_DESCRIPTOR_INVALID', 'Content descriptor is invalid.');
    }
    const key = parseContentKey(descriptor);
    let encoded: string;
    try {
      encoded = await readFile(contentFilePath(rootDir, key), 'utf8');
    } catch {
      fail('CORE_CONTENT_UNAVAILABLE', 'Captured content is unavailable.');
    }
    let document: ContentDocument;
    try {
      document = parseContentDocument(JSON.parse(encoded) as unknown);
    } catch (error: unknown) {
      if (error instanceof NodeCoreContentStoreError) throw error;
      fail('CORE_CONTENT_DOCUMENT_INVALID', 'Captured content document is invalid.');
    }
    if (canonicalizeJson(document.descriptor) !== canonicalizeJson(descriptor)) {
      fail(
        'CORE_CONTENT_DOCUMENT_INVALID',
        'Resolved content descriptor differs from the requested descriptor.',
      );
    }
    return deepFreezeCanonicalJson({
      value: document.value,
      classification: document.classification,
      mediaType: document.descriptor.mediaType,
    });
  }

  async function put(request: Readonly<
    ExecutionContentStoreRequest | EvaluationContentStoreRequest
  >): Promise<ContentDescriptor> {
    if (request.mediaType === '') {
      fail('CORE_CONTENT_REQUEST_INVALID', 'Content media type must not be empty.');
    }
    let value: JsonValue;
    try {
      value = parseWireDocument(JsonValueSchema, request.value) as JsonValue;
    } catch {
      fail('CORE_CONTENT_REQUEST_INVALID', 'Content value is not canonical JSON.');
    }
    if (digestCanonicalJson(value) !== request.digest) {
      fail(
        'CORE_CONTENT_REQUEST_INVALID',
        'Content store request digest does not match its value.',
      );
    }
    const size = Buffer.byteLength(canonicalizeJson(value), 'utf8');
    const key = contentKey({
      digest: request.digest,
      mediaType: request.mediaType,
      classification: request.classification,
    });
    const descriptor = parseWireDocument(ContentDescriptorSchema, {
      digest: request.digest,
      mediaType: request.mediaType,
      size,
      uri: `${CONTENT_URI_PREFIX}${key}`,
    });
    const payload = {
      schemaVersion: CONTENT_DOCUMENT_SCHEMA_VERSION,
      contentDocumentKind: 'evaluation-captured-content' as const,
      descriptor,
      classification: request.classification,
      value,
    };
    const document = parseContentDocument({
      ...payload,
      contentDocumentDigest: digestCanonicalJson(payload),
    });
    await ensurePrivateDirectory(join(rootDir, 'content'));
    const outcome = await publishPrivateJsonExclusive(
      contentFilePath(rootDir, key),
      document,
    );
    if (outcome === 'exists') {
      const existing = await resolve(descriptor);
      if (canonicalizeJson(existing) !== canonicalizeJson({
        value,
        classification: request.classification,
        mediaType: request.mediaType,
      })) {
        fail(
          'CORE_CONTENT_IDENTITY_CONFLICT',
          'Content identity collides with different persisted content.',
        );
      }
    }
    return deepFreezeCanonicalJson(descriptor);
  }

  return Object.freeze({ put, resolve });
}
