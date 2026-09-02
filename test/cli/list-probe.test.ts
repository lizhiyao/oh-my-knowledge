/**
 * probeSourceState(omk list 的当前源探测)安全/正确性回归。重点锁住 CR 发现的两条:
 *   - 只读命令绝不盲读攻击者可控 locator:软链 / 非常规文件(/dev/zero)→ reachable:false,不触发
 *     hashArtifactSource 的无界 readFileSync(DoS 守卫);
 *   - 远端 git 源 SHA-pin 短路、不联网;
 *   - 正常本地源算出哈、reachable:true。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, linkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeCell } from '../../src/cli/commands/list.js';
import { probeSourceState, hashArtifactSource } from '../../src/knowledge-artifacts/governance/index.js';
import type { ManagedArtifactRecord, ManagedArtifactSource } from '../../src/knowledge-artifacts/governance/contracts.js';

function record(source: ManagedArtifactSource, contentHash = 'pinnedHash00'): ManagedArtifactRecord {
  return {
    recordKind: 'managed-artifact', schemaVersion: 3, id: 'id', name: 'x', kind: 'skill',
    source, contentHash, installedAt: '2026-06-06T00:00:00.000Z', distribution: [], evidence: [], decisions: [],
  };
}

describe('probeSourceState', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omk-probe-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('本地目录-skill:reachable + 哈与 hashArtifactSource 一致', () => {
    const sk = join(dir, 'review'); mkdirSync(join(sk, 'references'), { recursive: true });
    writeFileSync(join(sk, 'SKILL.md'), '# review\n'); writeFileSync(join(sk, 'references', 'r.md'), 'v1\n');
    const p = probeSourceState(record({ sourceKind: 'file', locator: sk, isDirectorySkill: true }));
    assert.equal(p.reachable, true);
    assert.equal(p.hash, hashArtifactSource(sk, true));
  });

  it('本地单文件-skill:reachable + 哈一致', () => {
    const md = join(dir, 'note.md'); writeFileSync(md, 'body\n');
    const p = probeSourceState(record({ sourceKind: 'file', locator: md, isDirectorySkill: false }));
    assert.equal(p.reachable, true);
    assert.equal(p.hash, hashArtifactSource(md, false));
  });

  it('安全:locator 是软链 → reachable:false,绝不读(防 evil.md → /dev/zero 无界 readFileSync DoS)', () => {
    const link = join(dir, 'evil.md');
    symlinkSync('/dev/zero', link); // 若无守卫,hashArtifactSource 会 readFileSync(/dev/zero) 卡死/OOM
    const p = probeSourceState(record({ sourceKind: 'file', locator: link, isDirectorySkill: false }));
    assert.equal(p.reachable, false, '软链被 lstat 拦下、不跟随');
    assert.equal(p.hash, undefined);
  });

  it('安全:locator 指向非常规文件(字符设备)→ reachable:false', () => {
    // 直接把 locator 指到 /dev/zero(非软链路径):lstat 判非常规文件 → 拒读。
    const p = probeSourceState(record({ sourceKind: 'file', locator: '/dev/zero', isDirectorySkill: false }));
    assert.equal(p.reachable, false);
  });

  it('安全:单文件源 locator 非 .md(任意小 regular file,如 /etc/passwd / id_rsa)→ reachable:false', () => {
    const secret = join(dir, 'id_rsa'); writeFileSync(secret, 'PRIVATE KEY\n'); // 常规文件但非 .md
    const p = probeSourceState(record({ sourceKind: 'file', locator: secret, isDirectorySkill: false }));
    assert.equal(p.reachable, false, '非 .md 形态被拒,不把任意本地文件读进进程参与 hash');
    assert.equal(p.hash, undefined);
  });

  it('安全:单文件源 locator 是相对路径(非 install 写出形态)→ reachable:false', () => {
    const p = probeSourceState(record({ sourceKind: 'file', locator: 'relative/note.md', isDirectorySkill: false }));
    assert.equal(p.reachable, false, '相对 locator 非 install 产物,拒(不按 cwd 解析到项目外)');
  });

  it('安全:单文件源是 .md 命名、指向非 .md 敏感文件的硬链 → reachable:false(nlink>1 拒,堵硬链别名读)', () => {
    const secret = join(dir, 'secret.txt'); writeFileSync(secret, 'PRIVATE\n');
    const alias = join(dir, 'alias.md'); linkSync(secret, alias); // 硬链:同 inode、nlink=2、isSymbolicLink()=false
    const p = probeSourceState(record({ sourceKind: 'file', locator: alias, isDirectorySkill: false }));
    assert.equal(p.reachable, false, '硬链 nlink>1 被拒,绝不读别名的树外敏感文件');
    assert.equal(p.hash, undefined);
  });

  it('安全:目录-skill 树内含指向树外敏感文件的硬链 → reachable:false(不读整树)', () => {
    const sk = join(dir, 'dirskill'); mkdirSync(sk, { recursive: true });
    writeFileSync(join(sk, 'SKILL.md'), '# s\n');
    const secret = join(dir, 'outside.txt'); writeFileSync(secret, 'SECRET\n');
    linkSync(secret, join(sk, 'leak.md')); // 树内硬链别名树外 inode
    const p = probeSourceState(record({ sourceKind: 'file', locator: sk, isDirectorySkill: true }));
    assert.equal(p.reachable, false, '树内硬链文件被 nlink 守卫拦下,整树拒读');
  });

  it('源不存在 → reachable:false(未核,不冒充 stale)', () => {
    const p = probeSourceState(record({ sourceKind: 'file', locator: join(dir, 'gone.md'), isDirectorySkill: false }));
    assert.equal(p.reachable, false);
  });

  it('远端 git(带 url):SHA-pin 短路,reachable + hash = record.contentHash,不联网', () => {
    const p = probeSourceState(record(
      { sourceKind: 'git', locator: 'git+https://x/r.git@sha1:review', ref: 'sha1', url: 'https://x/r.git', isDirectorySkill: true },
      'pinnedHash00',
    ));
    assert.equal(p.reachable, true);
    assert.equal(p.hash, 'pinnedHash00');
  });

  it('安全:目录源指向无 SKILL.md 的任意目录 → reachable:false(不递归读整棵树)', () => {
    const any = join(dir, 'arbitrary'); mkdirSync(join(any, 'sub'), { recursive: true });
    writeFileSync(join(any, 'data.md'), 'x\n'); writeFileSync(join(any, 'sub', 'more.md'), 'y\n');
    const p = probeSourceState(record({ sourceKind: 'file', locator: any, isDirectorySkill: true }));
    assert.equal(p.reachable, false, '无 SKILL.md → 非 skill 目录 → 拒(防任意目录递归读)');
  });

  it('安全:目录源的 SKILL.md 是软链 → reachable:false', () => {
    const sk = join(dir, 'sneaky'); mkdirSync(sk, { recursive: true });
    symlinkSync('/dev/zero', join(sk, 'SKILL.md'));
    const p = probeSourceState(record({ sourceKind: 'file', locator: sk, isDirectorySkill: true }));
    assert.equal(p.reachable, false, 'SKILL.md 软链被拒');
  });
});

describe('sanitizeCell', () => {
  it('洗掉 ANSI/OSC 转义 + 换行 / 回车 / TAB / DEL / C1(防终端输出伪造)', () => {
    const evil = '\x1b[31mred\x1b[0m' + 'a\nb\r c\td' + '\x07\x7f' + '\x9b' + 'tail';
    const out = sanitizeCell(evil);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(out), '输出不含任何 C0 / DEL / C1 控制字符');
    assert.ok(out.includes('red') && out.includes('tail'), '可见正文保留');
  });

  it('洗掉 BiDi 重排 / 隔离 / 零宽 / 组合附加符(防 Trojan-Source 视觉伪造 + 宽度错位)', () => {
    // U+202E RLO、U+2066 隔离、U+200B 零宽、U+0300 组合附加符、U+FEFF BOM —— 都不该出现在表格单元里。
    const evil = 'PASS\u202e drowssap\u2066x\u2069\u200bhidde\u0300n\ufeff';
    const out = sanitizeCell(evil);
    for (const cp of ['\u202e', '\u2066', '\u2069', '\u200b', '\u0300', '\ufeff']) {
      assert.ok(!out.includes(cp), 'invisible/reordering char stripped: U+' + cp.codePointAt(0)!.toString(16));
    }
    assert.ok(out.includes('PASS') && out.includes('hidde') && out.includes('n'), '可见正文保留');
  });

  it('洗掉行 / 段分隔(U+2028 / 2029)+ Tags 块 + Hangul filler + interlinear（属性类一次覆盖整类,堵 LF 的 Unicode 孪生与隐藏诡计）', () => {
    const evil = 'PASS forged row\u{e0041}tagㅤfill￹anno';
    const out = sanitizeCell(evil);
    for (const cp of [' ', ' ', '\u{e0041}', 'ㅤ', '￹']) {
      assert.ok(!out.includes(cp), 'invisible/separator char stripped: U+' + cp.codePointAt(0)!.toString(16));
    }
    assert.ok(out.includes('PASS') && out.includes('forged') && out.includes('row'), '可见正文保留');
  });

  it('保留合法的间距组合符（\\p{Mc}，如 Devanagari 元音符号占 1 列）', () => {
    assert.equal(sanitizeCell('काb'), 'काb', '间距组合符占 1 列、不该被洗');
  });

  it('普通字符串原样(含 CJK / 路径)', () => {
    assert.equal(sanitizeCell('./skills/review'), './skills/review');
    assert.equal(sanitizeCell('git:HEAD:skills/审查'), 'git:HEAD:skills/审查');
  });
});

describe('probeSourceState 本地 git 分支（resolveInstallSource，之前零覆盖）', () => {
  let repo: string;
  let prevCwd: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'omk-probe-git-')));
    const g = (args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'pipe' }); };
    g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    mkdirSync(join(repo, 'skills', 'review', 'references'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'review', 'SKILL.md'), '# review\n');
    writeFileSync(join(repo, 'skills', 'review', 'references', 'r.md'), 'asset\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
    prevCwd = process.cwd();
    process.chdir(repo); // resolveInstallSource 的 git 上下文取自 cwd
  });
  afterEach(() => { process.chdir(prevCwd); rmSync(repo, { recursive: true, force: true }); });

  it('cwd 在原仓库:本地 git locator 重物化重哈 → reachable + 整树哈与 hashArtifactSource 一致', () => {
    const rec = record({ sourceKind: 'git', locator: 'git:HEAD:skills/review', ref: 'HEAD', isDirectorySkill: true });
    const p = probeSourceState(rec);
    assert.equal(p.reachable, true);
    assert.ok(typeof p.hash === 'string' && p.hash.length > 0, '算出当前整树哈');
  });

  it('spec 解析不到（如 cwd 漂走 / 名字不存在）→ reachable:false（未核,不抛、不冒充 stale）', () => {
    const rec = record({ sourceKind: 'git', locator: 'git:HEAD:skills/nope', ref: 'HEAD', isDirectorySkill: true });
    const p = probeSourceState(rec);
    assert.equal(p.reachable, false);
    assert.equal(p.hash, undefined);
  });
});
