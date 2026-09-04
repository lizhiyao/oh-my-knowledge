import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST = join(PROJECT_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

function gitWorkspacePaths() {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: PROJECT_ROOT, encoding: 'utf8' },
  );
  if (listed.status !== 0) {
    throw new Error(`Unable to enumerate repository files:\n${listed.stderr}`);
  }
  return listed.stdout.split('\0').filter(Boolean);
}

function collectTree(root, output) {
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  const repositoryPath = relative(PROJECT_ROOT, root);
  if (stat.isSymbolicLink()) {
    output.add(repositoryPath);
    return;
  }
  if (stat.isFile()) {
    output.add(repositoryPath);
    return;
  }
  for (const entry of readdirSync(root).sort()) {
    collectTree(join(root, entry), output);
  }
}

function digestPath(repositoryPath) {
  const absolutePath = join(PROJECT_ROOT, repositoryPath);
  if (!existsSync(absolutePath)) return 'missing';
  const stat = lstatSync(absolutePath);
  const hash = createHash('sha256');
  hash.update(repositoryPath);
  hash.update('\0');
  hash.update(String(stat.mode));
  hash.update('\0');
  if (stat.isSymbolicLink()) {
    hash.update(`link:${readlinkSync(absolutePath)}`);
  } else if (stat.isFile()) {
    hash.update(readFileSync(absolutePath));
  } else {
    hash.update('directory');
  }
  return hash.digest('hex');
}

function workspaceSnapshot() {
  const paths = new Set(gitWorkspacePaths());
  // These paths remain guarded even if a future ignore rule would otherwise hide them.
  for (const repositoryPath of ['.omk', 'artifacts/cr', 'knowledge/cr']) {
    collectTree(join(PROJECT_ROOT, repositoryPath), paths);
  }
  return new Map([...paths].sort().map((path) => [path, digestPath(path)]));
}

function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

const before = workspaceSnapshot();
const result = spawnSync(process.execPath, [VITEST, 'run', ...process.argv.slice(2)], {
  cwd: PROJECT_ROOT,
  env: process.env,
  stdio: 'inherit',
});
const after = workspaceSnapshot();
const mutations = changedPaths(before, after);

if (mutations.length > 0) {
  process.stderr.write('\n[test-hermetic] Tests modified repository-owned content:\n');
  for (const path of mutations) process.stderr.write(`  - ${path}\n`);
  process.stderr.write('Write test artifacts under an OS temporary directory and clean them in teardown.\n');
}

if (result.error) {
  process.stderr.write(`${result.error.stack ?? result.error.message}\n`);
}
process.exit(result.status === 0 && mutations.length === 0 ? 0 : 1);
