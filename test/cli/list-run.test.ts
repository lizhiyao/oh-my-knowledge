/**
 * `omk list` 端到端编排测(execFile 打到 dist):锁住 run() 这层一直没覆盖的契约 ——
 *   - 表格走 stdout、表头 / 注脚走 stderr(`omk list | grep` 才不被装饰行污染);
 *   - `--json` 出**版本化信封** `{ schemaVersion, rows }`(脚本可检测形态变更);
 *   - drift_note 仅在有漂移行时出、unreachable_note 仅在有不可达行时出(两个谓词不被写反);
 *   - 空目录走 empty 文案、stdout 不出表。
 * HOME 指到临时空目录,避免 resolveManagedDir 回退到本机真实全局受管目录污染断言。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

interface Rec { name: string; locator: string; isDirectorySkill: boolean; contentHash: string; }
function writeRecord(dir: string, r: Rec): void {
  const rec = {
    recordKind: 'managed-artifact', schemaVersion: 2, id: `skill-${r.name}`, name: r.name, kind: 'skill',
    source: { sourceKind: 'file', locator: r.locator, isDirectorySkill: r.isDirectorySkill },
    contentHash: r.contentHash, installedAt: '2026-06-06T00:00:00.000Z',
    distribution: [], evidence: [], decisions: [],
  };
  writeFileSync(join(dir, `skill-${r.name}.json`), JSON.stringify(rec));
}

describe('omk list 端到端', () => {
  let proj: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let managed: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'omk-list-proj-'));
    home = mkdtempSync(join(tmpdir(), 'omk-list-home-'));
    env = { ...process.env, HOME: home, USERPROFILE: home };
    managed = join(proj, '.omk', 'managed');
    mkdirSync(managed, { recursive: true });
  });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  const run = (args: string[]) => execFileAsync('node', [CLI, 'list', '--lang', 'en', ...args], { cwd: proj, env });

  it('漂移行:表格走 stdout、drift_note 走 stderr,不出 unreachable_note', async () => {
    // 真源存在但 contentHash 故意写错 → reachable 且漂移 → drifted。
    writeFileSync(join(proj, 'a.md'), '# real\n');
    writeRecord(managed, { name: 'alpha', locator: join(proj, 'a.md'), isDirectorySkill: false, contentHash: 'WRONGHASH000' });
    const { stdout, stderr } = await run([]);
    assert.ok(stdout.includes('alpha'), '表格(含行名)应在 stdout');
    assert.ok(stdout.includes('stale'), '漂移行表格状态为 stale');
    assert.ok(stderr.includes('Managed skills'), '表头在 stderr');
    assert.ok(stderr.includes('drifted'), 'drift_note 在 stderr');
    assert.ok(!stderr.includes('unreachable'), '无不可达行 → 不出 unreachable_note');
    assert.ok(!stdout.includes('Managed skills'), 'stdout 不含装饰行(可安全 grep)');
  });

  it('不可达行:出 unreachable_note,不出 drift_note', async () => {
    writeRecord(managed, { name: 'beta', locator: join(proj, 'gone', 'x.md'), isDirectorySkill: false, contentHash: 'h' });
    const { stdout, stderr } = await run([]);
    assert.ok(stdout.includes('beta'));
    assert.ok(stderr.includes('unreachable'), 'unreachable_note 在 stderr');
    assert.ok(!stderr.includes('drifted'), '无漂移行 → 不出 drift_note');
  });

  it('--json:输出版本化信封 { schemaVersion:1, rows:[...] },stdout 可直接 JSON.parse', async () => {
    writeFileSync(join(proj, 'a.md'), '# real\n');
    writeRecord(managed, { name: 'gamma', locator: join(proj, 'a.md'), isDirectorySkill: false, contentHash: 'WRONGHASH000' });
    const { stdout } = await run(['--json']);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.schemaVersion, 1, 'JSON 带 schemaVersion 信封');
    assert.ok(Array.isArray(parsed.rows), 'rows 是数组');
    assert.equal(parsed.rows[0].name, 'gamma');
    assert.equal(parsed.rows[0].sourceLabel, join(proj, 'a.md'), 'file 源 sourceLabel = locator');
  });

  it('空目录:走 empty 文案、stdout 不出表', async () => {
    const { stdout, stderr } = await run([]);
    assert.equal(stdout.trim(), '', '无记录 → stdout 不出表');
    assert.ok(stderr.includes('No managed records'), 'stderr 出 empty 文案');
  });
});
