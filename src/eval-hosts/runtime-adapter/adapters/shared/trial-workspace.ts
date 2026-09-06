import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface NodeTrialWorkspace {
  readonly workingDirectory: string;
  close(): Promise<void>;
}

/** One writable workspace per Trial; attempts in that Trial share its state. */
export async function openNodeTrialWorkspace(input: {
  readonly parentRoot: string;
  readonly baseSnapshotPath?: string;
  readonly signal: AbortSignal;
}): Promise<NodeTrialWorkspace> {
  input.signal.throwIfAborted();
  const workingDirectory = await mkdtemp(join(input.parentRoot, 'trial-'));
  const copyDirectory = async (source: string, destination: string): Promise<void> => {
    input.signal.throwIfAborted();
    const directory = await lstat(source);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new TypeError('Trial workspace requires a verified directory snapshot.');
    }
    for (const entry of await readdir(source, { withFileTypes: true })) {
      input.signal.throwIfAborted();
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      if (entry.isDirectory()) {
        await mkdir(to, { mode: 0o700 });
        await copyDirectory(from, to);
      } else if (entry.isFile()) {
        const metadata = await lstat(from);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new TypeError('Trial workspace snapshot changed during copying.');
        }
        await copyFile(from, to);
        await chmod(to, 0o600 | (metadata.mode & 0o111));
      } else {
        throw new TypeError('Trial workspace snapshot contains an unsupported entry.');
      }
    }
  };
  try {
    if (input.baseSnapshotPath !== undefined) {
      await copyDirectory(input.baseSnapshotPath, workingDirectory);
    }
    input.signal.throwIfAborted();
    let cleanup: Promise<void> | undefined;
    return Object.freeze({
      workingDirectory,
      close() {
        cleanup ??= rm(workingDirectory, { recursive: true, force: true });
        return cleanup;
      },
    });
  } catch (error) {
    await rm(workingDirectory, { recursive: true, force: true });
    throw error;
  }
}
