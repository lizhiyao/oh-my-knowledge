/**
 * oclif 路径 install 命令验收。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}

function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, OMK_SKIP_UPDATE_CHECK: '1', ...extra };
}

describe('oclif install', () => {
  it('--help 默认 zh', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'install', '--help']);
    assert.ok(stdout.includes('安装或接管 knowledge input'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('omk-agent-skill'), 'stdout missing builtin id');
  });

  it('--help --lang en', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'install', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('Install or adopt a knowledge input'), 'stdout should contain en description');
  });

  it('unknown flag → exit 2', async () => {
    try {
      await execFileAsync('node', [CLI, 'install', 'omk-agent-skill', '--bogus']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
    }
  });

  it('installs omk-agent-skill into a custom skill root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-'));
    try {
      const dest = join(dir, 'skills-root');
      const { stdout } = await execFileAsync('node', [CLI, 'install', 'omk-agent-skill', '--dest', dest]);
      assert.ok(stdout.includes('已安装 omk Agent Skill'), `stdout missing install msg:\n${stdout}`);
      assert.ok(existsSync(join(dest, 'omk', 'SKILL.md')), 'SKILL.md not installed');
      assert.ok(existsSync(join(dest, 'omk', 'references', 'commands.md')), 'commands reference not installed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('auto installs into detected local supported targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-auto-'));
    try {
      const home = join(dir, 'home');
      await mkdir(join(home, '.codex'), { recursive: true });
      await mkdir(join(home, '.claude'), { recursive: true });
      const { stdout } = await execFileAsync('node', [CLI, 'install', 'omk-agent-skill'], {
        env: cliEnv({ HOME: home }),
      });
      assert.equal((stdout.match(/已安装 omk Agent Skill/g) ?? []).length, 2, `stdout should list two installs:\n${stdout}`);
      assert.ok(existsSync(join(home, '.agents', 'skills', 'omk', 'SKILL.md')), 'Codex/AGENTS target not installed');
      assert.ok(existsSync(join(home, '.claude', 'skills', 'omk', 'SKILL.md')), 'Claude Code target not installed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('auto detects AGENTS root directories, not same-named files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-auto-file-'));
    try {
      const home = join(dir, 'home');
      await mkdir(home, { recursive: true });
      await writeFile(join(home, '.codex'), 'not a directory');
      try {
        await execFileAsync('node', [CLI, 'install', 'omk-agent-skill'], {
          env: cliEnv({ HOME: home }),
        });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as ExecError;
        assert.notEqual(e.code, 0);
        assert.ok((e.stdout + e.stderr).includes('未检测到本机支持的 agent skill 目录'));
      }
      assert.ok(!existsSync(join(home, '.agents')), 'same-named file detection must not create AGENTS root');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports explicit multiple targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-explicit-multi-'));
    try {
      const home = join(dir, 'home');
      await mkdir(home, { recursive: true });
      const { stdout } = await execFileAsync('node', [CLI, 'install', 'omk-agent-skill', '--to', 'codex,claude'], {
        env: cliEnv({ HOME: home }),
      });
      assert.equal((stdout.match(/已安装 omk Agent Skill/g) ?? []).length, 2, `stdout should list two installs:\n${stdout}`);
      assert.ok(existsSync(join(home, '.agents', 'skills', 'omk', 'SKILL.md')), 'Codex/AGENTS target not installed');
      assert.ok(existsSync(join(home, '.claude', 'skills', 'omk', 'SKILL.md')), 'Claude Code target not installed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects mixed auto/all target combinations', async () => {
    for (const to of ['auto,codex', 'all,claude']) {
      try {
        await execFileAsync('node', [CLI, 'install', 'omk-agent-skill', '--to', to]);
        assert.fail(`expected non-zero exit for --to ${to}`);
      } catch (err) {
        const e = err as ExecError;
        assert.notEqual(e.code, 0);
        const out = e.stdout + e.stderr;
        assert.ok(out.includes('安装目标组合不合法'), `missing invalid combo message for ${to}:\n${out}`);
      }
    }
  });

  it('auto fails when no supported local target is detected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-auto-missing-'));
    try {
      const home = join(dir, 'home');
      await mkdir(home, { recursive: true });
      try {
        await execFileAsync('node', [CLI, 'install', 'omk-agent-skill'], {
          env: cliEnv({ HOME: home }),
        });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as ExecError;
        assert.notEqual(e.code, 0);
        const out = e.stdout + e.stderr;
        assert.ok(out.includes('未检测到本机支持的 agent skill 目录'), `missing detected-target hint:\n${out}`);
        assert.ok(out.includes('--to codex') && out.includes('--dest'), `missing explicit target guidance:\n${out}`);
      }
      assert.ok(!existsSync(join(home, '.agents')), 'auto must not create AGENTS root without detection');
      assert.ok(!existsSync(join(home, '.claude')), 'auto must not create Claude root without detection');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite existing install without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-exists-'));
    try {
      const dest = join(dir, 'skills-root');
      await execFileAsync('node', [CLI, 'install', 'omk-agent-skill', '--dest', dest]);
      try {
        await execFileAsync('node', [CLI, 'install', 'omk-agent-skill', '--dest', dest]);
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as ExecError;
        assert.notEqual(e.code, 0);
        assert.ok((e.stdout + e.stderr).includes('--force'), 'error should mention --force');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--force overwrites existing install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-force-'));
    try {
      const dest = join(dir, 'skills-root');
      const skillMd = join(dest, 'omk', 'SKILL.md');
      await execFileAsync('node', [CLI, 'install', 'omk-agent-skill', '--dest', dest]);
      await writeFile(skillMd, 'local edit');
      await execFileAsync('node', [CLI, 'install', 'omk-agent-skill', '--dest', dest, '--force']);
      const body = await readFile(skillMd, 'utf8');
      assert.ok(body.includes('name: omk'), 'force install should restore packaged skill');
      assert.ok(!body.includes('local edit'), 'force install should overwrite local edit');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--dry-run prints target and does not write files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-dry-'));
    try {
      const dest = join(dir, 'skills-root');
      const { stdout } = await execFileAsync('node', [CLI, 'install', 'omk-agent-skill', '--dest', dest, '--dry-run']);
      assert.ok(stdout.includes('将安装 omk Agent Skill 到'), `stdout missing plan msg:\n${stdout}`);
      assert.ok(!existsSync(join(dest, 'omk')), 'dry-run must not create target');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('unknown input exits non-zero', async () => {
    try {
      await execFileAsync('node', [CLI, 'install', 'other-skill']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.notEqual(e.code, 0);
      assert.ok((e.stdout + e.stderr).includes('omk-agent-skill'), 'error should mention supported builtin id');
    }
  });
});
