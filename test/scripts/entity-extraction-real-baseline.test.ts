import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/bench/assets/entity-extraction-real-v14-baseline-v1/verify.mjs');
const manifest = JSON.parse(readFileSync(join(dirname(script), 'manifest.json'), 'utf8'));
const temporary: string[] = [];
function scratch() { const path = mkdtempSync(join(tmpdir(), 'omk-real-baseline-test-')); temporary.push(path); return path; }
function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: scratch(), env: { TMPDIR: tmpdir(), ...env } });
}
function rejected(result: ReturnType<typeof run>, stage: string) {
  expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toEqual({ verificationKind: 'omk-external-entity-baseline-verification/v1', status: 'rejected', stage,
    attemptedOperations: { fetch: 0, socket: 0, listen: 0, http: 0, tls: 0, datagram: 0, subprocess: 0 } });
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('explicit external historical capture verifier (no private fixture or model access)', () => {
  it('shows help without locating or reading historical originals', () => {
    const result = run(['--help']); expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toContain('--capture-dir');
  });
  it.each([{ args: [], stage: 'arguments' }, { args: ['--capture-dir', 'relative'], stage: 'capture-directory' },
    { args: ['--capture-dir', '/tmp', '--capture-dir', '/tmp'], stage: 'arguments' }])('requires an explicit capture directory: $stage', ({ args, stage }) => rejected(run(args), stage));
  it('rejects inherited Node runtime options before reading the capture', () => {
    rejected(run(['--capture-dir', scratch()], { NODE_OPTIONS: '--no-warnings' }), 'arguments');
  });
  it('does not scan other files or leak paths/text when a fixed capture file is missing', () => {
    const capture = scratch(); writeFileSync(join(capture, 'private-marker.txt'), 'PRIVATE-CAPTURE-SENTINEL');
    const result = run(['--capture-dir', capture]); rejected(result, 'capture-files');
    expect(result.stderr).not.toContain(capture); expect(result.stderr).not.toContain('PRIVATE-CAPTURE-SENTINEL');
  });
  it.each(['wrong-length', 'wrong-hash', 'symlink'])('refuses %s evidence before any production decoder import', mode => {
    const capture = scratch(); mkdirSync(join(capture, 'capture'));
    const target = join(capture, 'capture/checks.json');
    if (mode === 'symlink') { const privateFile = join(capture, 'private.json'); writeFileSync(privateFile, 'PRIVATE-CAPTURE-SENTINEL'); symlinkSync(privateFile, target); }
    else writeFileSync(target, mode === 'wrong-length' ? 'PRIVATE-CAPTURE-SENTINEL' : Buffer.alloc(manifest.files[0].bytes, 65));
    const result = run(['--capture-dir', capture]); rejected(result, 'capture-files');
    expect(result.stderr).not.toContain('PRIVATE-CAPTURE-SENTINEL'); expect(result.stderr).not.toContain(capture);
  });
  it('rejects reports inside originals or the checkout before writing and preserves existing reports', () => {
    const capture = scratch(); const existing = join(scratch(), 'report.json'); writeFileSync(existing, 'KEEP');
    for (const target of [join(capture, 'new-report.json'), join(root, 'forbidden-real-baseline-report.json'), existing]) {
      rejected(run(['--capture-dir', capture, '--out', target]), 'capture-directory');
      if (target !== existing) expect(existsSync(target)).toBe(false);
    }
    expect(readFileSync(existing, 'utf8')).toBe('KEEP');
  });
});
