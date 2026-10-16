export interface JsonResponseBody<T> {
  data: T | null;
  rawBody: string;
}

export const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Keep provider selection identical for Core Responses and auxiliary Chat calls. */
export function resolveOpenAiEndpoint(baseUrl: string | undefined, operation: 'responses' | 'chat/completions'): string {
  const invalid = (): never => { throw new TypeError('OPENAI_BASE_URL must be a credential-free HTTP(S) base URL without query or fragment.'); };
  let base: URL;
  try { base = new URL(baseUrl || 'https://api.openai.com'); } catch { return invalid(); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return invalid();
  const prefix = base.pathname.replace(/\/+$/, '');
  base.pathname = `${prefix.endsWith('/v1') ? prefix : `${prefix}/v1`}/${operation}`;
  return base.href;
}

export class ApiResponseCapacityError extends Error {
  constructor() { super(`API response exceeded ${MAX_API_RESPONSE_BYTES} bytes.`); }
}

export async function readJsonResponse<T>(response: Response): Promise<JsonResponseBody<T>> {
  if (Number(response.headers.get('content-length')) > MAX_API_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new ApiResponseCapacityError();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_API_RESPONSE_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new ApiResponseCapacityError();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const rawBody = new TextDecoder().decode(Buffer.concat(chunks, size));
  if (!rawBody.trim()) return { data: null, rawBody };
  try {
    return { data: JSON.parse(rawBody) as T, rawBody };
  } catch {
    return { data: null, rawBody };
  }
}

export function responseBodyPreview(rawBody: string, maxLength = 500): string {
  const normalized = rawBody.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}
