import { resolve } from 'node:path';

/**
 * Selects the primary directory when it contains domain data, otherwise a distinct
 * fallback directory when that contains data. An empty pair always resolves to primary.
 */
export function resolveDataDirectory(
  primaryDirectory: string,
  fallbackDirectory: string,
  hasData: (directory: string) => boolean,
): string {
  if (hasData(primaryDirectory)) return primaryDirectory;
  if (resolve(primaryDirectory) !== resolve(fallbackDirectory) && hasData(fallbackDirectory)) {
    return fallbackDirectory;
  }
  return primaryDirectory;
}
