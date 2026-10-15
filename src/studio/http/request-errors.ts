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

export function readJsonObjectBody(
  request: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<Record<string, unknown>> {
  assertJsonContentType(request);
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value: Record<string, unknown> = {}): void => {
      if (settled) return;
      settled = true;
      request.pause();
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('close', onClose);
      chunks.length = 0;
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        finish(new RequestBodyError('request body too large', 413, 'request_body_too_large'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish(new RequestBodyError('json body must be an object', 400, 'json_body_not_object'));
          return;
        }
        finish(undefined, parsed as Record<string, unknown>);
      } catch {
        finish(new RequestBodyError('invalid json body', 400, 'invalid_json_body'));
      }
    };
    const onError = (): void => finish(new RequestBodyError('request body interrupted', 400, 'invalid_json_body'));
    const onClose = (): void => { if (!settled) onError(); };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('close', onClose);
    if (request.readableEnded) onEnd();
    else if (request.destroyed) onError();
  });
}
