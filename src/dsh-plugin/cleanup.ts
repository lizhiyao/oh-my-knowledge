export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

export function captureCleanupTimeout(value = DEFAULT_CLEANUP_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError('DSH Host cleanupTimeoutMs must be an integer between 1 and 2147483647.');
  }
  return value;
}

export async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
