import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const PROBE_PATH = join(
  REPO_ROOT,
  'test/evaluation-core/fixtures/core-side-effect-probe.mjs',
);
const CORE_DIST_ENTRY = join(REPO_ROOT, 'dist/evaluation-core/contracts/index.js');

function directorySnapshot(root: string): string[] {
  const snapshot: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      const size = entry.isFile() ? statSync(path).size : 0;
      snapshot.push(`${relative(root, path)}:${kind}:${size}`);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return snapshot.sort();
}

describe('Evaluation Core 宿主副作用边界', () => {
  it('在隔离进程导入内部入口并运行纯内存操作时零宿主副作用', () => {
    if (!existsSync(CORE_DIST_ENTRY)) {
      throw new Error('缺少 dist/evaluation-core；请先运行 yarn build。');
    }

    const sandboxRoot = mkdtempSync(join(tmpdir(), 'omk-core-side-effects-'));
    const workingDirectory = join(sandboxRoot, 'cwd');
    const userDirectory = join(sandboxRoot, 'home');
    const configDirectory = join(userDirectory, '.config');
    const tempDirectory = join(sandboxRoot, 'tmp');
    mkdirSync(workingDirectory);
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(tempDirectory);
    const before = directorySnapshot(sandboxRoot);

    try {
      const result = spawnSync(process.execPath, [PROBE_PATH, REPO_ROOT], {
        cwd: workingDirectory,
        encoding: 'utf8',
        env: {
          HOME: userDirectory,
          USERPROFILE: userDirectory,
          XDG_CONFIG_HOME: configDirectory,
          OMK_HOME: userDirectory,
          TMPDIR: tempDirectory,
        },
        timeout: 30_000,
      });

      expect({
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      }).toEqual({
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        error: undefined,
      });
      expect(directorySnapshot(sandboxRoot)).toEqual(before);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});
