import type { IncomingMessage } from 'node:http';
import type { StudioApiErrorCode } from './errors.js';

export class RequestBodyError extends Error {
  override readonly name = 'RequestBodyError';

  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 413 | 415,
    readonly code: StudioApiErrorCode,
  ) {
    super(message);
  }
}

export function assertTrustedMutationRequest(request: IncomingMessage): void {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    throw new RequestBodyError('cross-origin mutation is not allowed', 403, 'mutation_not_trusted');
  }

  const origin = request.headers.origin;
  if (!origin) return;
  if (Array.isArray(origin) || !request.headers.host) {
    throw new RequestBodyError('cross-origin mutation is not allowed', 403, 'mutation_not_trusted');
  }
  try {
    if (new URL(origin).host !== request.headers.host) {
      throw new RequestBodyError('cross-origin mutation is not allowed', 403, 'mutation_not_trusted');
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError('cross-origin mutation is not allowed', 403, 'mutation_not_trusted');
  }
}

function assertJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers['content-type'];
  const mediaType = typeof contentType === 'string'
    ? contentType.split(';', 1)[0].trim().toLowerCase()
    : '';
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return;
  request.pause();
  throw new RequestBodyError('content-type must be application/json', 415, 'unsupported_media_type');
}

/** Bounded byte intake; selected consumers parse JSON in a fixed worker. Own backing storage is transferable. */
export function readJsonBodyBytes(request: IncomingMessage, maxBytes = 1024 * 1024, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  assertJsonContentType(request);
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks: Buffer[] = [];
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true; request.pause();
      request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      if (error) { chunks.length = 0; reject(error); }
      else {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0; resolve(bytes);
      }
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
      if (size > maxBytes) { finish(new RequestBodyError('request body too large', 413, 'request_body_too_large')); return; }
      chunks.push(buffer);
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(new RequestBodyError('request body interrupted', 400, 'invalid_json_body'));
    const onClose = (): void => { if (!settled) onError(); };
    const onAbort = (): void => onError();
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted || request.destroyed) onError();
    else if (request.readableEnded) onEnd();
  });
}

export async function readJsonObjectBody(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const bytes = await readJsonBodyBytes(request, maxBytes);
  let parsed: unknown;
  try { const raw = Buffer.from(bytes.buffer).toString('utf8').trim(); parsed = raw ? JSON.parse(raw) as unknown : {}; }
  catch { throw new RequestBodyError('invalid json body', 400, 'invalid_json_body'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RequestBodyError('json body must be an object', 400, 'json_body_not_object');
  return parsed as Record<string, unknown>;
}
