export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Browser responses must not expose filesystem paths, credentials, or provider errors.
export const STUDIO_SOURCE_UNAVAILABLE = 'studio_source_unavailable';
