/**
 * oclif 路径 install 命令验收。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import InstallCommand from '../../src/cli/commands/install.js';
import { renderCommandHelp, runCommand, type CommandRunError } from '../helpers/run-command.js';


async function runInstallCommand(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand(InstallCommand, args, options);
}

function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, OMK_SKIP_UPDATE_CHECK: '1', ...extra };
}

describe('oclif install', () => {

  it('--help 默认 zh', async () => {
    const stdout = await renderCommandHelp('install');
    assert.ok(stdout.includes('安装 omk 官方 Agent Skill'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('omk-agent-skill'), 'stdout missing builtin id');
  });

  it('--help --lang en', async () => {
    const stdout = await renderCommandHelp('install', 'en');
    assert.ok(stdout.includes('Install the official omk Agent Skill'), 'stdout should contain en description');
  });

  it('installs omk-agent-skill into a custom skill root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-'));
    try {
      const dest = join(dir, 'skills-root');
      const { stdout } = await runInstallCommand(['omk-agent-skill', '--dest', dest]);
      assert.ok(stdout.includes('已安装 omk Agent Skill'), `stdout missing install msg:\n${stdout}`);
      assert.ok(stdout.includes('现在可以在 coding agent 中说'), `stdout missing next hint:\n${stdout}`);
      assert.ok(existsSync(join(dest, 'omk', 'SKILL.md')), 'SKILL.md not installed');
      assert.ok(existsSync(join(dest, 'omk', 'references', 'commands.md')), 'commands reference not installed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints runtime messages in English', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-en-'));
    try {
      const dest = join(dir, 'skills-root');
      const { stdout } = await runInstallCommand(['omk-agent-skill', '--dest', dest, '--lang', 'en']);
      assert.ok(stdout.includes('Installed omk Agent Skill'), `stdout missing en install msg:\n${stdout}`);
      assert.ok(stdout.includes('You can now ask your coding agent'), `stdout missing en next hint:\n${stdout}`);
      assert.ok(existsSync(join(dest, 'omk', 'SKILL.md')), 'SKILL.md not installed');
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
      const { stdout } = await runInstallCommand(['omk-agent-skill'], {
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
        await runInstallCommand(['omk-agent-skill'], {
          env: cliEnv({ HOME: home }),
        });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as CommandRunError;
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
      const { stdout } = await runInstallCommand(['omk-agent-skill', '--to', 'codex,claude'], {
        env: cliEnv({ HOME: home }),
      });
      assert.equal((stdout.match(/已安装 omk Agent Skill/g) ?? []).length, 2, `stdout should list two installs:\n${stdout}`);
      assert.ok(existsSync(join(home, '.agents', 'skills', 'omk', 'SKILL.md')), 'Codex/AGENTS target not installed');
      assert.ok(existsSync(join(home, '.claude', 'skills', 'omk', 'SKILL.md')), 'Claude Code target not installed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports --to all without detected targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-all-'));
    try {
      const home = join(dir, 'home');
      await mkdir(home, { recursive: true });
      const { stdout } = await runInstallCommand(['omk-agent-skill', '--to', 'all'], {
        env: cliEnv({ HOME: home }),
      });
      assert.equal((stdout.match(/已安装 omk Agent Skill/g) ?? []).length, 2, `stdout should list two installs:\n${stdout}`);
      assert.ok(existsSync(join(home, '.agents', 'skills', 'omk', 'SKILL.md')), 'Codex/AGENTS target not installed');
      assert.ok(existsSync(join(home, '.claude', 'skills', 'omk', 'SKILL.md')), 'Claude Code target not installed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports explicit single targets', async () => {
    for (const target of ['codex', 'claude'] as const) {
      const dir = await mkdtemp(join(tmpdir(), `omk-install-${target}-`));
      try {
        const home = join(dir, 'home');
        await mkdir(home, { recursive: true });
        const { stdout } = await runInstallCommand(['omk-agent-skill', '--to', target], {
          env: cliEnv({ HOME: home }),
        });
        assert.equal((stdout.match(/已安装 omk Agent Skill/g) ?? []).length, 1, `stdout should list one install:\n${stdout}`);
        const installed = target === 'codex'
          ? join(home, '.agents', 'skills', 'omk', 'SKILL.md')
          : join(home, '.claude', 'skills', 'omk', 'SKILL.md');
        assert.ok(existsSync(installed), `${target} target not installed`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('rejects unknown install targets', async () => {
    try {
      await runInstallCommand(['omk-agent-skill', '--to', 'gemini']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as CommandRunError;
      assert.notEqual(e.code, 0);
      assert.ok((e.stdout + e.stderr).includes('未知安装目标'), 'error should mention unknown install target');
    }
  });

  it('rejects mixed auto/all target combinations', async () => {
    for (const to of ['auto,codex', 'all,claude']) {
      try {
        await runInstallCommand(['omk-agent-skill', '--to', to]);
        assert.fail(`expected non-zero exit for --to ${to}`);
      } catch (err) {
        const e = err as CommandRunError;
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
        await runInstallCommand(['omk-agent-skill'], {
          env: cliEnv({ HOME: home }),
        });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as CommandRunError;
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
      await runInstallCommand(['omk-agent-skill', '--dest', dest]);
      try {
        await runInstallCommand(['omk-agent-skill', '--dest', dest]);
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as CommandRunError;
        assert.notEqual(e.code, 0);
        assert.ok((e.stdout + e.stderr).includes('--force'), 'error should mention --force');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preflights existing targets before multi-target install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-preflight-'));
    try {
      const home = join(dir, 'home');
      const claudeSkill = join(home, '.claude', 'skills', 'omk');
      await mkdir(claudeSkill, { recursive: true });
      await writeFile(join(claudeSkill, 'SKILL.md'), 'existing claude install');

      try {
        await runInstallCommand(['omk-agent-skill', '--to', 'codex,claude'], {
          env: cliEnv({ HOME: home }),
        });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as CommandRunError;
        assert.notEqual(e.code, 0);
        assert.ok((e.stdout + e.stderr).includes('--force'), 'error should mention --force');
      }

      assert.ok(!existsSync(join(home, '.agents')), 'preflight failure must not partially install Codex target');
      assert.equal(await readFile(join(claudeSkill, 'SKILL.md'), 'utf8'), 'existing claude install');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--force overwrites existing install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-force-'));
    try {
      const dest = join(dir, 'skills-root');
      const skillMd = join(dest, 'omk', 'SKILL.md');
      await runInstallCommand(['omk-agent-skill', '--dest', dest]);
      await writeFile(skillMd, 'local edit');
      await runInstallCommand(['omk-agent-skill', '--dest', dest, '--force']);
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
      const { stdout } = await runInstallCommand(['omk-agent-skill', '--dest', dest, '--dry-run']);
      assert.ok(stdout.includes('将安装 omk Agent Skill 到'), `stdout missing plan msg:\n${stdout}`);
      assert.ok(!existsSync(join(dest, 'omk')), 'dry-run must not create target');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('unknown bare token exits non-zero and points at supported inputs', async () => {
    try {
      await runInstallCommand(['other-skill']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as CommandRunError;
      assert.notEqual(e.code, 0);
      assert.ok((e.stdout + e.stderr).includes('omk-agent-skill'), 'error should mention supported builtin id');
    }
  });

  // —— 用户 skill:登记 + 分发 ——

  async function makeDirSkill(root: string, name: string): Promise<string> {
    const skillDir = join(root, 'skills', name);
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: demo\n---\n# ${name}\nbody\n`);
    await writeFile(join(skillDir, 'references', 'cmd.md'), 'asset\n');
    return skillDir;
  }

  it('directory-skill:分发整目录(--kind 可省自动推导)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-userskill-'));
    try {
      await makeDirSkill(dir, 'review');
      const dest = join(dir, 'dist-skills');
      const { stdout } = await runInstallCommand(['skills/review', '--dest', dest], {
        cwd: dir,
        env: cliEnv(),
      });
      assert.ok(stdout.includes('已安装 skill review'), `stdout missing copy msg:\n${stdout}`);
      assert.ok(existsSync(join(dest, 'review', 'SKILL.md')), 'skill SKILL.md not distributed');
      assert.ok(existsSync(join(dest, 'review', 'references', 'cmd.md')), 'asset not distributed');
      assert.ok(!existsSync(join(dir, '.omk')), 'installation must not create lifecycle metadata');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('file-skill:目标是 .md 文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-fileskill-'));
    try {
      await writeFile(join(dir, 'notes.md'), `---\nname: notes\ndescription: demo\n---\n# notes\nbody\n`);
      const dest = join(dir, 'dist-skills');
      await runInstallCommand(['notes.md', '--kind', 'skill', '--dest', dest], {
        cwd: dir,
        env: cliEnv(),
      });
      assert.ok(existsSync(join(dest, 'notes.md')), 'file-skill not distributed as .md');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--dry-run 不分发', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-userskill-dry-'));
    try {
      await makeDirSkill(dir, 'review');
      const dest = join(dir, 'dist-skills');
      await runInstallCommand(['skills/review', '--dest', dest, '--dry-run'], {
        cwd: dir,
        env: cliEnv(),
      });
      assert.ok(!existsSync(join(dest, 'review')), 'dry-run must not distribute');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--force 重装幂等:覆盖已安装文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-userskill-force-'));
    try {
      await makeDirSkill(dir, 'review');
      const dest = join(dir, 'dist-skills');
      await runInstallCommand(['skills/review', '--dest', dest], { cwd: dir, env: cliEnv() });
      await writeFile(join(dir, 'skills', 'review', 'SKILL.md'), '# Updated review\n');
      await runInstallCommand(['skills/review', '--dest', dest, '--force'], { cwd: dir, env: cliEnv() });
      assert.equal(await readFile(join(dest, 'review', 'SKILL.md'), 'utf8'), '# Updated review\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('源已在目标位置：源即目标时不删源(P1 数据丢失防护)', async () => {
    for (const force of [true, false]) {
      const dir = await mkdtemp(join(tmpdir(), 'omk-install-adopt-'));
      try {
        // skill 已经躺在目标 skillsDir 里:install <skillsDir>/review --dest <skillsDir>
        await makeDirSkill(dir, 'review'); // → <dir>/skills/review
        const skillsDir = join(dir, 'skills');
        const source = join(skillsDir, 'review');
        const args = ['skills/review', '--dest', 'skills'];
        if (force) args.push('--force');
        await runInstallCommand(args, { cwd: dir, env: cliEnv() });
        // 源必须还在(绝不能被自删)
        assert.ok(existsSync(join(source, 'SKILL.md')), `adopt(force=${force}) must not delete the source skill`);
        assert.ok(existsSync(join(source, 'references', 'cmd.md')), 'asset must survive');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('名为 evolve 的 directory-skill 正常安装,不被根目录过滤误伤(P2 边界)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-evolvename-'));
    try {
      await makeDirSkill(dir, 'evolve'); // skill 本身就叫 evolve
      const dest = join(dir, 'dist-skills');
      const { stdout } = await runInstallCommand(['skills/evolve', '--dest', dest], { cwd: dir, env: cliEnv() });
      assert.ok(stdout.includes('已安装 skill evolve'), 'should report install');
      assert.ok(existsSync(join(dest, 'evolve', 'SKILL.md')), '源根名叫 evolve 不该让整棵目录被跳过');
      assert.ok(existsSync(join(dest, 'evolve', 'references', 'cmd.md')), 'asset must be distributed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('嵌套 references/evolve 资产正常分发,仅源根 evolve 排除(P2 边界)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-nestedevolve-'));
    try {
      await makeDirSkill(dir, 'review');
      await mkdir(join(dir, 'skills', 'review', 'references', 'evolve'), { recursive: true });
      await writeFile(join(dir, 'skills', 'review', 'references', 'evolve', 'guide.md'), 'guide\n');
      await mkdir(join(dir, 'skills', 'review', 'evolve'), { recursive: true }); // 源根 evolve:应排除
      await writeFile(join(dir, 'skills', 'review', 'evolve', 'cand.md'), 'cand\n');
      const dest = join(dir, 'dist-skills');
      await runInstallCommand(['skills/review', '--dest', dest], { cwd: dir, env: cliEnv() });
      assert.ok(existsSync(join(dest, 'review', 'references', 'evolve', 'guide.md')), '嵌套 evolve 资产应被分发');
      assert.ok(!existsSync(join(dest, 'review', 'evolve')), '源根 evolve 不应被分发');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('源嵌套在目标内:拒绝执行、绝不删源(P1 数据丢失防护)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-overlap-'));
    try {
      // skill 在 <dir>/skills/review/review,目标 dest=<dir>/skills → target=<dir>/skills/review(源的祖先)
      const skillRoot = join(dir, 'skills', 'review', 'review');
      await mkdir(join(skillRoot, 'references'), { recursive: true });
      await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: review\ndescription: d\n---\n# review\n');
      await writeFile(join(dir, 'skills', 'review', 'keep.txt'), 'precious');
      try {
        await runInstallCommand(['skills/review/review', '--dest', 'skills', '--force'], { cwd: dir, env: cliEnv() });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as CommandRunError;
        assert.notEqual(e.code, 0);
      }
      assert.ok(existsSync(join(skillRoot, 'SKILL.md')), '源 skill 绝不能被删');
      assert.equal(await readFile(join(dir, 'skills', 'review', 'keep.txt'), 'utf8'), 'precious', '兄弟文件不能被波及');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('裸名匹配到 cwd 普通文件时不被当 skill 安装,落回 unknown_input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-barefile-'));
    try {
      await writeFile(join(dir, 'omk-agnt-skill'), 'junk'); // typo 的内置 id,恰好 cwd 有同名文件
      try {
        await runInstallCommand(['omk-agnt-skill'], { cwd: dir, env: cliEnv() });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as CommandRunError;
        assert.notEqual(e.code, 0);
        assert.ok((e.stdout + e.stderr).includes('omk-agent-skill'), 'should fall back to unknown_input');
      }
      assert.ok(!existsSync(join(dir, '.omk')), 'must not create metadata a junk file as a skill');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('分发不带入 .omk 评测数据(P2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-omkfilter-'));
    try {
      await makeDirSkill(dir, 'review');
      await mkdir(join(dir, 'skills', 'review', '.omk'), { recursive: true });
      await writeFile(join(dir, 'skills', 'review', '.omk', 'eval-samples.json'), '[]\n');
      const dest = join(dir, 'dist-skills');
      await runInstallCommand(['skills/review', '--dest', dest], { cwd: dir, env: cliEnv() });
      assert.ok(existsSync(join(dest, 'review', 'SKILL.md')), 'skill distributed');
      assert.ok(!existsSync(join(dest, 'review', '.omk')), '.omk 评测数据不应被分发到 agent skill 目录');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('显式 --kind prompt 报友好错误且不登记', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-userskill-prompt-'));
    try {
      await makeDirSkill(dir, 'review');
      const dest = join(dir, 'dist-skills');
      try {
        await runInstallCommand(['skills/review', '--kind', 'prompt', '--dest', dest], {
          cwd: dir,
          env: cliEnv(),
        });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as CommandRunError;
        assert.notEqual(e.code, 0);
        assert.ok((e.stdout + e.stderr).includes('skill'), 'error should mention skill-only support');
      }
      assert.ok(!existsSync(join(dir, '.omk')), 'unsupported kind must not create metadata');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // —— git 源 ——

  function git(repo: string, args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }

  async function makeGitRepoWithSkill(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'omk-install-gitrepo-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    await makeDirSkill(repo, 'review'); // <repo>/skills/review
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
    return repo;
  }

  it('git 源:从当前仓库 ref 安装,分发整树', async () => {
    const repo = await makeGitRepoWithSkill();
    try {
      const dest = join(repo, 'dist-skills');
      const history = join(repo, '.omk', 'governance', 'managed', 'old.json');
      const previous = '{"original":"user history"}\n';
      await mkdir(join(repo, '.omk', 'governance', 'managed'), { recursive: true });
      await writeFile(history, previous);
      const { stdout } = await runInstallCommand(['git:HEAD:skills/review', '--dest', dest], { cwd: repo, env: cliEnv() });
      assert.ok(stdout.includes('已安装 skill review'), `stdout missing copy msg:\n${stdout}`);
      assert.ok(existsSync(join(dest, 'review', 'SKILL.md')), 'git skill SKILL.md not distributed');
      assert.ok(existsSync(join(dest, 'review', 'references', 'cmd.md')), 'git skill asset not distributed');
      assert.equal(await readFile(history, 'utf8'), previous, 'installation must leave old user data untouched');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('git 源 --force 重装幂等:覆盖已安装文件', async () => {
    const repo = await makeGitRepoWithSkill();
    try {
      const dest = join(repo, 'dist-skills');
      await runInstallCommand(['git:HEAD:skills/review', '--dest', dest], { cwd: repo, env: cliEnv() });
      await runInstallCommand(['git:HEAD:skills/review', '--dest', dest, '--force'], { cwd: repo, env: cliEnv() });
      assert.ok(existsSync(join(dest, 'review', 'SKILL.md')), 'force 重装后目标仍在');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('git 源 --dry-run 不分发,文案源中性', async () => {
    const repo = await makeGitRepoWithSkill();
    try {
      const dest = join(repo, 'dist-skills');
      const { stdout } = await runInstallCommand(['git:HEAD:skills/review', '--dest', dest, '--dry-run'], { cwd: repo, env: cliEnv() });
      assert.ok(!existsSync(join(dest, 'review')), 'dry-run must not distribute');
      assert.ok(!existsSync(join(repo, '.omk')), 'dry-run must not create metadata');
      assert.ok(stdout.includes('将安装 skill review'), `plan 文案应源中性:\n${stdout}`);
      assert.ok(!stdout.includes('omk Agent Skill'), 'user skill 的 dry-run 不应提 omk Agent Skill');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('git 源裸 spec 歧义：文件优先，与评测输入解析一致', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'omk-install-gitdual-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.email', 't@t']);
      git(repo, ['config', 'user.name', 't']);
      await mkdir(join(repo, 'skills', 'dual'), { recursive: true });
      await writeFile(join(repo, 'skills', 'dual.md'), '# dual file\n');
      await writeFile(join(repo, 'skills', 'dual', 'SKILL.md'), '# dual dir\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-q', '-m', 'dual']);
      const dest = join(repo, 'dist-skills');
      await runInstallCommand(['git:HEAD:skills/dual', '--dest', dest], { cwd: repo, env: cliEnv() });
      assert.ok(existsSync(join(dest, 'dual.md')), '应分发文件-skill,落点为 dual.md');
      assert.ok(!existsSync(join(dest, 'dual')), '不应分发目录-skill');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('git 源在非 git 仓库内友好报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-install-nogit-'));
    try {
      try {
        await runInstallCommand(['git:HEAD:review'], { cwd: dir, env: cliEnv() });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as CommandRunError;
        assert.notEqual(e.code, 0);
        assert.ok((e.stdout + e.stderr).includes('git'), 'error should mention git repo');
      }
      assert.ok(!existsSync(join(dir, '.omk')), 'must not create metadata on error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
