import { z } from 'zod';
import {
  JsonValueSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
} from '../../../eval-core/contracts/index.js';

const ApiTransportIdentitySchema = z.object({
  transportId: z.string().min(1),
  version: z.string().min(1).optional(),
  fingerprint: z.string().min(1),
  fingerprintBasis: z.enum([
    'content-derived',
    'environment-derived',
    'self-reported',
    'opaque',
  ]),
  assuranceLevel: z.enum(['verified', 'declared', 'unknown']),
  concurrencySafety: z.literal('parallel-safe'),
  cancellation: z.literal('cooperative'),
  retrySemantics: z.literal('none'),
}).strict();

export type ApiTransportIdentity = z.infer<typeof ApiTransportIdentitySchema>;

export interface CoreApiTransportRequest {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface CoreApiTransport {
  /**
   * A transport is trusted host code. It must be safe for concurrent requests,
   * forward the supplied AbortSignal to the underlying I/O, and perform no
   * retries below the Core attempt boundary.
   */
  readonly identity: ApiTransportIdentity;
  request(input: Readonly<CoreApiTransportRequest>): Promise<Response>;
}

export interface CapturedCoreApiTransport {
  readonly identity: ApiTransportIdentity;
  request(input: Readonly<CoreApiTransportRequest>): Promise<Response>;
}

export class ApiResponseLimitError extends Error {
  constructor() {
    super('API response exceeded the configured byte limit.');
    this.name = 'ApiResponseLimitError';
  }
}

export class ApiResponseBodyError extends Error {
  constructor() {
    super('API response body was not valid UTF-8 JSON.');
    this.name = 'ApiResponseBodyError';
  }
}

export function requiredApiHeaderValue(value: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new TypeError(`${label} must be a non-empty header-safe string.`);
  return value;
}

export function normalizeCoreApiEndpoint(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL.`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol)
    || endpoint.username !== ''
    || endpoint.password !== ''
    || endpoint.hash !== ''
    || endpoint.search !== ''
  ) throw new TypeError(`${label} must be an absolute credential-free HTTP(S) URL.`);
  const loopback = endpoint.hostname === 'localhost'
    || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !loopback) {
    throw new TypeError(`${label} must use HTTPS unless it is loopback-only.`);
  }
  return endpoint.toString();
}

function defaultTransport(): CoreApiTransport {
  if (typeof globalThis.fetch !== 'function') {
    throw new TypeError('API Core adapters require a global fetch implementation.');
  }
  const fetchImplementation = globalThis.fetch.bind(globalThis);
  const nodeVersion = process.versions.node;
  return {
    identity: {
      transportId: 'node.global-fetch',
      version: nodeVersion,
      fingerprint: digestCanonicalJson({
        derivation: 'omk.node-global-fetch-transport/v1',
        nodeVersion,
      }),
      fingerprintBasis: 'environment-derived',
      assuranceLevel: 'declared',
      concurrencySafety: 'parallel-safe',
      cancellation: 'cooperative',
      retrySemantics: 'none',
    },
    request(input) {
      return fetchImplementation(input.endpoint, {
        method: 'POST',
        headers: { ...input.headers },
        body: input.body,
        signal: input.signal,
        redirect: 'error',
      });
    },
  };
}

export function captureCoreApiTransport(
  input: CoreApiTransport | undefined,
): CapturedCoreApiTransport {
  const transport = input ?? defaultTransport();
  if (transport === null || typeof transport !== 'object' || typeof transport.request !== 'function') {
    throw new TypeError('API transport must provide an identity and request method.');
  }
  const identity = deepFreezeCanonicalJson(
    ApiTransportIdentitySchema.parse(structuredClone(transport.identity)),
  ) as ApiTransportIdentity;
  const request = transport.request.bind(transport);
  return Object.freeze({ identity, request });
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The caller is already discarding this response. Cancellation is best effort.
  }
}

export async function discardApiResponse(response: Response): Promise<void> {
  await cancelBody(response);
}

export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<JsonValue | null> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await cancelBody(response);
      throw new ApiResponseLimitError();
    }
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* response already fails closed */ }
        throw new ApiResponseLimitError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) return null;
  let text: string;
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ApiResponseBodyError();
  }
  try {
    return JsonValueSchema.parse(JSON.parse(text) as unknown);
  } catch {
    throw new ApiResponseBodyError();
  }
}
