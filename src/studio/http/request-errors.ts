import type { IncomingMessage } from 'node:http';

export class RequestBodyError extends Error {
  override readonly name = 'RequestBodyError';

  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 413 | 415,
  ) {
    super(message);
  }
}

export function assertTrustedMutationRequest(request: IncomingMessage): void {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    throw new RequestBodyError('cross-origin mutation is not allowed', 403);
  }

  const origin = request.headers.origin;
  if (!origin) return;
  if (Array.isArray(origin) || !request.headers.host) {
    throw new RequestBodyError('cross-origin mutation is not allowed', 403);
  }
  try {
    if (new URL(origin).host !== request.headers.host) {
      throw new RequestBodyError('cross-origin mutation is not allowed', 403);
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError('cross-origin mutation is not allowed', 403);
  }
}

function assertJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers['content-type'];
  const mediaType = typeof contentType === 'string'
    ? contentType.split(';', 1)[0].trim().toLowerCase()
    : '';
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return;
  request.resume();
  throw new RequestBodyError('content-type must be application/json', 415);
}

export function readJsonObjectBody(
  request: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<Record<string, unknown>> {
  assertJsonContentType(request);
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(new RequestBodyError('request body too large', 413));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new RequestBodyError('json body must be an object', 400));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new RequestBodyError('invalid json body', 400));
      }
    });
    request.on('error', reject);
  });
}
