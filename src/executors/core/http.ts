export interface JsonResponseBody<T> {
  data: T | null;
  rawBody: string;
}

export async function readJsonResponse<T>(response: Response): Promise<JsonResponseBody<T>> {
  const rawBody = await response.text();
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
