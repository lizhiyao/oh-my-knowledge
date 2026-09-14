import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJSON } from './release-evidence.mjs';

const integrity = file => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
const execute = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024, ...options,
});

export function verifyBundle(directory, sha, expected) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package-manifest.json'), 'utf8'));
  if (manifest.commit !== sha || manifest.name !== expected.name || manifest.version !== expected.version
    || manifest.filename !== basename(manifest.filename) || !/^[\w.-]+\.tgz$/.test(manifest.filename)) throw new Error('Release package identity mismatch');
  const file = join(directory, manifest.filename);
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || integrity(file) !== manifest.integrity) throw new Error('Release package digest mismatch');
  return { manifest, file };
}

export async function publicationState(manifest, read = readJSON) {
  const existing = await read(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`);
  if (existing === null) return 'absent';
  if (existing.name !== manifest.name || existing.version !== manifest.version || existing.dist?.integrity !== manifest.integrity) {
    throw new Error('Published version has different or unavailable integrity. Do not overwrite or republish.');
  }
  return 'identical';
}

export function pack(directory, sha, run = execute) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Commit SHA required');
  mkdirSync(directory, { recursive: true });
  const expected = JSON.parse(readFileSync('package.json', 'utf8'));
  const [result] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory]));
  if (result.name !== expected.name || result.version !== expected.version || basename(result.filename) !== result.filename) throw new Error('Packed package identity mismatch');
  const manifest = { name: result.name, version: result.version, filename: result.filename, commit: sha,
    integrity: integrity(join(directory, result.filename)) };
  writeFileSync(join(directory, 'package-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function smoke(directory, sha, run = execute) {
  const expected = JSON.parse(readFileSync('package.json', 'utf8'));
  const { file, manifest } = verifyBundle(directory, sha, expected);
  const root = mkdtempSync(join(tmpdir(), 'omk-release-smoke-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'omk-install-smoke', private: true }));
    const env = { ...process.env, OMK_HOME: join(root, 'state'), OMK_SKIP_UPDATE_CHECK: '1', npm_config_cache: join(root, 'npm-cache') };
    run('npm', ['install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', file], { env });
    const installed = join(root, 'node_modules', expected.name);
    const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    if (pkg.name !== expected.name || pkg.version !== expected.version) throw new Error('Installed package identity mismatch');
    const version = run(process.execPath, [join(installed, 'dist/cli/index.js'), '--version'], { cwd: root, env });
    if (!version.includes(expected.version)) throw new Error('Installed CLI version mismatch');
    run(process.execPath, [join(installed, 'dist/cli/index.js'), '--help'], { cwd: root, env });
    run(process.execPath, ['--input-type=module', '-e', "await import('oh-my-knowledge'); await import('oh-my-knowledge/eval-core');"], { cwd: root, env });
    for (const path of ['dist/studio/web/.next/BUILD_ID', 'dist/eval-core/contracts/schemas', 'dist/assets/agent-skills/omk/SKILL.md']) {
      if (!existsSync(join(installed, path))) throw new Error(`Missing installed asset: ${path}`);
    }
    verifyBundle(directory, sha, expected);
    writeFileSync(join(directory, 'package-smoke.json'), JSON.stringify({ commit: sha, version: expected.version, integrity: manifest.integrity, status: 'passed' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export async function publish(directory, sha, tag, { run = execute, read = readJSON } = {}) {
  const expected = JSON.parse(readFileSync('package.json', 'utf8'));
  const { manifest, file } = verifyBundle(directory, sha, expected);
  const smokeResult = JSON.parse(readFileSync(join(directory, 'package-smoke.json'), 'utf8'));
  if (smokeResult.commit !== sha || smokeResult.version !== manifest.version || smokeResult.status !== 'passed' || smokeResult.integrity !== manifest.integrity) throw new Error('Package smoke evidence missing');
  if (tag !== (manifest.version.includes('-') ? 'next' : 'latest')) throw new Error('Invalid release channel');
  if (await publicationState(manifest, read) === 'identical') {
    console.log('Registry already contains this exact package; skipping duplicate upload.'); return;
  }
  // Publish only the verified bytes. No lifecycle rebuild and no automatic write retry.
  run('npm', ['publish', file, '--ignore-scripts', '--access', 'public', '--tag', tag], { stdio: 'inherit' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, path, tag] = process.argv.slice(2); if (!path) throw new Error('Explicit bundle directory required');
  const directory = resolve(path); const sha = process.env.GITHUB_SHA;
  if (operation === 'pack') pack(directory, sha);
  else if (operation === 'smoke') smoke(directory, sha);
  else if (operation === 'publish') await publish(directory, sha, tag);
  else throw new Error('Unknown package operation');
}
