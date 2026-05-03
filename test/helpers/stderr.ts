// Not safe with Vitest `it.concurrent`: this patches process.stderr.write
// process-wide and assumes no same-process tests need stderr simultaneously.
type StderrWrite = typeof process.stderr.write;

export interface CapturedStderr {
  read(): string;
  restore(): void;
}

export function captureStderr(): CapturedStderr {
  const original = process.stderr.write;
  let output = '';

  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void), callback?: (err?: Error | null) => void): boolean => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    cb?.();
    return true;
  }) as StderrWrite;

  return {
    read: () => output,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

export async function withCapturedStderr<T>(fn: () => T | Promise<T>): Promise<{ result: T; stderr: string }> {
  const capture = captureStderr();
  try {
    const result = await fn();
    return { result, stderr: capture.read() };
  } finally {
    capture.restore();
  }
}
