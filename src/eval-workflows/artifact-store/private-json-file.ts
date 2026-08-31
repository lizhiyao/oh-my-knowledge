import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  await writeFile(path, JSON.stringify(value, null, 2), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

export async function publishPrivateJsonExclusive(
  path: string,
  value: unknown,
): Promise<'published' | 'exists'> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await link(temporary, path);
      return 'published';
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function publishPrivateDirectoryExclusive(
  stagingPath: string,
  finalPath: string,
): Promise<'published' | 'exists'> {
  try {
    await rename(stagingPath, finalPath);
    return 'published';
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return 'exists';
    throw error;
  }
}
