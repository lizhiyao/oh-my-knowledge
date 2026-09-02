/**
 * 内容寻址隔离副本单测。eval 把任意源在测量前落地成一份隔离副本(executor cwd 锚到副本、不碰真源),
 * 路径按 contentHash 命名 —— 同内容同路径(cache/runtime FP 稳定)、改资产即换路径。copy / hash /
 * 副本三者口径必须一致(与 install 分发同 filter)。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeIsolatedCopy, treesDir, pruneTreesDir } from '../../src/inputs/materialize-copy.js';
import { hashArtifactSource } from '../../src/inputs/content-hash.js';

describe('materialize-copy', () => {
  let dir: string;
  let treesOverride: string;
  const created: string[] = [];
  const prevTreesEnv = process.env.OMK_TREES_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omk-mat-src-'));
    // 把 treesDir 重定向到本测独占的临时目录:既避免污染 ~/.oh-my-knowledge/state/trees,也让
    // 「不残留 .tmp-」这类全局扫描断言在并行 vitest 下不被别的测试文件的副本写入干扰。
    treesOverride = mkdtempSync(join(tmpdir(), 'omk-trees-'));
    process.env.OMK_TREES_DIR = treesOverride;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(treesOverride, { recursive: true, force: true });
    if (prevTreesEnv === undefined) delete process.env.OMK_TREES_DIR;
    else process.env.OMK_TREES_DIR = prevTreesEnv;
    for (const p of created.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  function mkDirSkill(name: string, asset: string): string {
    const root = join(dir, name);
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), `# ${name}\n`);
    writeFileSync(join(root, 'references', 'rules.md'), asset);
    return root;
  }

  it('目录-skill:副本路径 = treesDir/<hash>,含 references,contentHash 与整树哈一致', () => {
    const src = mkDirSkill('review', 'rule v1\n');
    const copy = materializeIsolatedCopy(src, true, 'review');
    created.push(copy.copyRoot);

    assert.equal(copy.isDirectorySkill, true);
    assert.equal(copy.copyRoot, join(treesDir(), copy.contentHash));
    assert.equal(copy.contentHash, hashArtifactSource(src, true), '副本 contentHash 与真源整树哈同值(可绑定)');
    assert.ok(existsSync(join(copy.copyRoot, 'SKILL.md')), '副本含 SKILL.md');
    assert.equal(readFileSync(join(copy.copyRoot, 'references', 'rules.md'), 'utf-8'), 'rule v1\n', '副本含 references 资产');
  });

  it('内容寻址:同内容两次 → 同一副本路径(复用、不重物化)', () => {
    const src = mkDirSkill('a', 'same\n');
    const c1 = materializeIsolatedCopy(src, true, 'a');
    const c2 = materializeIsolatedCopy(src, true, 'a');
    created.push(c1.copyRoot);
    assert.equal(c1.copyRoot, c2.copyRoot, '同内容落同一内容寻址路径');
    assert.equal(c1.contentHash, c2.contentHash);
  });

  it('改 references 资产 → contentHash 变 → 副本路径换新', () => {
    const src = mkDirSkill('b', 'rule v1\n');
    const c1 = materializeIsolatedCopy(src, true, 'b');
    writeFileSync(join(src, 'references', 'rules.md'), 'rule v2 changed\n');
    const c2 = materializeIsolatedCopy(src, true, 'b');
    created.push(c1.copyRoot, c2.copyRoot);
    assert.notEqual(c2.contentHash, c1.contentHash, '改资产即换指纹');
    assert.notEqual(c2.copyRoot, c1.copyRoot, '不同内容 → 不同副本路径');
  });

  it('排除 .omk / evolve(与 install 分发同 filter):副本不含、不影响 hash', () => {
    const src = mkDirSkill('c', 'asset\n');
    mkdirSync(join(src, '.omk'), { recursive: true });
    writeFileSync(join(src, '.omk', 'eval-samples.json'), '[]\n');
    mkdirSync(join(src, 'evolve'), { recursive: true });
    writeFileSync(join(src, 'evolve', 'cand.md'), 'x\n');
    const copy = materializeIsolatedCopy(src, true, 'c');
    created.push(copy.copyRoot);
    assert.ok(!existsSync(join(copy.copyRoot, '.omk')), '副本不含 .omk');
    assert.ok(!existsSync(join(copy.copyRoot, 'evolve')), '副本不含源根 evolve');
  });

  it('单文件-skill:副本落 treesDir/<hash>/<name>.md,<hash> 恒为目录', () => {
    const file = join(dir, 'notes.md');
    writeFileSync(file, 'body v1\n');
    const copy = materializeIsolatedCopy(file, false, 'notes');
    created.push(dirname(copy.copyRoot));
    assert.equal(copy.isDirectorySkill, false);
    assert.equal(copy.copyRoot, join(treesDir(), copy.contentHash, 'notes.md'));
    assert.equal(copy.contentHash, hashArtifactSource(file, false), '单文件副本 contentHash = 单文件字节哈');
    assert.equal(readFileSync(copy.copyRoot, 'utf-8'), 'body v1\n');
    // <hash> 是目录,里面只有 notes.md
    assert.deepEqual(readdirSync(join(treesDir(), copy.contentHash)), ['notes.md']);
  });

  it('物化后不残留 .tmp- 临时目录', () => {
    const src = mkDirSkill('d', 'asset\n');
    const copy = materializeIsolatedCopy(src, true, 'd');
    created.push(copy.copyRoot);
    const leftovers = readdirSync(treesDir()).filter((n) => n.startsWith('.tmp-'));
    assert.equal(leftovers.length, 0, '不留临时物化目录');
  });

  // 直接在 treesDir 造若干 <hash> 目录并设 mtime,验证 LRU 回收
  function mkTreeAged(name: string, ageMs: number): string {
    const p = join(treesDir(), name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'SKILL.md'), '# x\n');
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
    return p;
  }

  it('pruneTreesDir:超上限时按 mtime 从旧到新淘汰(graceMs:0 纯 LRU)', () => {
    const a = mkTreeAged('aaa', 30_000); // 最旧
    const b = mkTreeAged('bbb', 20_000);
    const c = mkTreeAged('ccc', 10_000); // 最新
    pruneTreesDir({ maxEntries: 1, graceMs: 0 });
    assert.ok(!existsSync(a), '最旧被淘汰');
    assert.ok(!existsSync(b), '次旧被淘汰');
    assert.ok(existsSync(c), '最新保留');
  });

  it('pruneTreesDir:grace 窗口内的副本一律不动(保护 active run 的 cwd)', () => {
    const old = mkTreeAged('old', 48 * 60 * 60 * 1000); // 2 天前
    const fresh = mkTreeAged('fresh', 1_000);           // 刚刚
    // cap=1、grace=24h:old 出窗口可淘汰,fresh 在窗口内受保护
    pruneTreesDir({ maxEntries: 1 });
    assert.ok(!existsSync(old), 'grace 外的旧副本被回收');
    assert.ok(existsSync(fresh), 'grace 内的新副本绝不被删(可能是正在跑的 eval 的 cwd)');
  });

  it('pruneTreesDir:.tmp- 暂存不计数、不被删', () => {
    mkdirSync(join(treesDir(), '.tmp-keep'), { recursive: true });
    mkTreeAged('h1', 30_000);
    mkTreeAged('h2', 20_000);
    pruneTreesDir({ maxEntries: 1, graceMs: 0 });
    assert.ok(existsSync(join(treesDir(), '.tmp-keep')), '.tmp- 暂存不参与淘汰');
  });

  function writeLock(hash: string, pid: number): string {
    const dir = join(treesDir(), '.locks');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${hash}.${pid}`);
    writeFileSync(p, '');
    return p;
  }

  it('pruneTreesDir:活进程占用锁的副本绝不被淘汰(即便超 grace + 超上限)', () => {
    const a = mkTreeAged('aaaaaaaaaaaa', 48 * 60 * 60 * 1000); // 旧 + 本进程占用
    const b = mkTreeAged('bbbbbbbbbbbb', 47 * 60 * 60 * 1000); // 旧 + 无锁
    writeLock('aaaaaaaaaaaa', process.pid); // 活 pid
    pruneTreesDir({ maxEntries: 0, graceMs: 0 }); // 强淘汰一切未保护的
    assert.ok(existsSync(a), '活进程占用锁的副本(可能是 active cwd)绝不删');
    assert.ok(!existsSync(b), '无锁的旧副本被淘汰');
  });

  it('pruneTreesDir:死 pid 的锁不保护、且被惰性清理', () => {
    const a = mkTreeAged('cccccccccccc', 48 * 60 * 60 * 1000);
    const deadPid = 2_000_000_000; // 远超 max pid → process.kill(pid,0) 抛 ESRCH
    const lock = writeLock('cccccccccccc', deadPid);
    pruneTreesDir({ maxEntries: 0, graceMs: 0 });
    assert.ok(!existsSync(a), '死 pid 锁不保护 → 副本被淘汰');
    assert.ok(!existsSync(lock), '死 pid 的锁被惰性回收');
  });

  it('materializeIsolatedCopy:物化落本进程 pid 占用锁', () => {
    const src = mkDirSkill('e', 'asset\n');
    const copy = materializeIsolatedCopy(src, true, 'e');
    created.push(copy.copyRoot);
    const lock = join(treesDir(), '.locks', `${copy.contentHash}.${process.pid}`);
    assert.ok(existsSync(lock), '物化后落了本进程的占用锁(prune 据此保护 active cwd)');
  });

  it('物化(under-cap、不触发 prune)也会回收死 pid 的锁(不靠 prune 才清)', () => {
    // 先种一个死 pid 的锁
    const deadLock = writeLock('deadbeef0000', 2_000_000_000);
    assert.ok(existsSync(deadLock));
    // 一次普通物化:trees 远未超上限、prune 早返回不淘汰,但死锁仍应被回收
    const src = mkDirSkill('f', 'asset\n');
    const copy = materializeIsolatedCopy(src, true, 'f');
    created.push(copy.copyRoot);
    assert.ok(!existsSync(deadLock), 'under-cap 物化也清死 pid 锁(否则死锁无界堆积)');
    assert.ok(existsSync(join(treesDir(), '.locks', `${copy.contentHash}.${process.pid}`)), '本进程活锁保留');
  });
});
