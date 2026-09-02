import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import {
  defaultCachePath,
  isStale,
  padToWidth,
  planUpdateActions,
  readCache,
  renderNotice,
  renderUpdateBox,
  shouldNotify,
  spawnDetached,
  visualWidth,
  writeCache,
  type UpdateCache,
} from '../../src/cli/lib/update-check.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3600_000).toISOString();

describe('readCache / writeCache', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omk-update-'));
    path = join(dir, 'update-check.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips a cache object', () => {
    const data: UpdateCache = {
      latestVersion: '0.33.0',
      lastCheckedAt: hoursAgo(1),
      lastNotifiedVersion: '0.33.0',
      lastNotifiedAt: hoursAgo(1),
    };
    writeCache(path, data);
    expect(readCache(path)).toEqual(data);
  });

  it('returns null on missing file', () => {
    expect(readCache(join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    writeFileSync(path, '{garbage');
    expect(readCache(path)).toBeNull();
  });

  it('returns null on non-object JSON (null / array)', () => {
    writeFileSync(path, 'null');
    expect(readCache(path)).toBeNull();
    writeFileSync(path, '[]');
    expect(readCache(path)).toBeNull();
  });

  it('returns null when the time anchor (lastCheckedAt) is missing', () => {
    writeFileSync(path, JSON.stringify({ latestVersion: '0.33.0' }));
    expect(readCache(path)).toBeNull();
  });

  it('accepts an attempt-only record (lastCheckedAt without latestVersion)', () => {
    const stamp = hoursAgo(1);
    writeFileSync(path, JSON.stringify({ lastCheckedAt: stamp }));
    expect(readCache(path)).toEqual({
      latestVersion: undefined,
      lastCheckedAt: stamp,
      lastNotifiedVersion: undefined,
      lastNotifiedAt: undefined,
    });
  });

  it('leaves no .tmp residue after an atomic write', () => {
    writeCache(path, { latestVersion: '0.33.0', lastCheckedAt: hoursAgo(1) });
    const leftover = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(leftover).toEqual([]);
  });
});

describe('defaultCachePath', () => {
  it('places the update cache below global state/cache', () => {
    const root = join(tmpdir(), 'omk-machine-root');
    expect(defaultCachePath(root)).toBe(join(root, 'state', 'cache', 'update-check.json'));
  });
});

describe('shouldNotify', () => {
  const base = (over: Partial<UpdateCache>): UpdateCache => ({
    latestVersion: '0.33.0',
    lastCheckedAt: hoursAgo(1),
    ...over,
  });

  it('false when cache is null', () => {
    expect(shouldNotify(null, '0.32.0', NOW)).toBe(false);
  });

  it('false for an attempt-only record (no latestVersion yet)', () => {
    expect(shouldNotify({ lastCheckedAt: hoursAgo(1) }, '0.32.0', NOW)).toBe(false);
  });

  it('false when latest equals current', () => {
    expect(shouldNotify(base({}), '0.33.0', NOW)).toBe(false);
  });

  it('false when latest is older than current (local dev rc)', () => {
    expect(shouldNotify(base({ latestVersion: '0.31.0' }), '0.32.0-rc.1', NOW)).toBe(false);
  });

  it('true when newer and never notified', () => {
    expect(shouldNotify(base({}), '0.32.0', NOW)).toBe(true);
  });

  it('false when same version notified within throttle window', () => {
    const cache = base({ lastNotifiedVersion: '0.33.0', lastNotifiedAt: hoursAgo(1) });
    expect(shouldNotify(cache, '0.32.0', NOW)).toBe(false);
  });

  it('true when same version was notified past the throttle window', () => {
    const cache = base({ lastNotifiedVersion: '0.33.0', lastNotifiedAt: hoursAgo(21) });
    expect(shouldNotify(cache, '0.32.0', NOW)).toBe(true);
  });

  it('true when a newer version supersedes the last notified one', () => {
    const cache = base({ lastNotifiedVersion: '0.32.5', lastNotifiedAt: hoursAgo(1) });
    expect(shouldNotify(cache, '0.32.0', NOW)).toBe(true);
  });
});

describe('isStale', () => {
  it('true when cache is null', () => {
    expect(isStale(null, NOW)).toBe(true);
  });
  it('false when checked 19h ago', () => {
    expect(isStale({ latestVersion: '0.33.0', lastCheckedAt: hoursAgo(19) }, NOW)).toBe(false);
  });
  it('true when checked 21h ago', () => {
    expect(isStale({ latestVersion: '0.33.0', lastCheckedAt: hoursAgo(21) }, NOW)).toBe(true);
  });
  it('true when timestamp is unparseable', () => {
    expect(isStale({ latestVersion: '0.33.0', lastCheckedAt: 'not-a-date' }, NOW)).toBe(true);
  });
});

describe('planUpdateActions', () => {
  it('no cache → refresh, and stamps lastCheckedAt now (no notice)', () => {
    const plan = planUpdateActions(null, '0.32.0', NOW);
    expect(plan.notify).toBe(false);
    expect(plan.refresh).toBe(true);
    expect(plan.nextCache).toEqual({ lastCheckedAt: NOW.toISOString() });
  });

  it('offline throttle: a second run within 20h does NOT refresh again (spawn once)', () => {
    // run 1:无缓存 → 发起刷新 + 落盘 attempt 戳
    const first = planUpdateActions(null, '0.32.0', NOW);
    expect(first.refresh).toBe(true);
    // run 2:registry 仍不通(worker 没写成功),缓存只有 attempt 戳;5 分钟后再跑
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const second = planUpdateActions(first.nextCache, '0.32.0', later);
    expect(second.refresh).toBe(false);
    expect(second.nextCache).toBeNull();
  });

  it('stale cache + newer version unseen → notify AND refresh, merged into one write', () => {
    const cache: UpdateCache = { latestVersion: '0.33.0', lastCheckedAt: hoursAgo(25) };
    const plan = planUpdateActions(cache, '0.32.0', NOW);
    expect(plan.notify).toBe(true);
    expect(plan.refresh).toBe(true);
    expect(plan.nextCache).toEqual({
      latestVersion: '0.33.0',
      lastCheckedAt: NOW.toISOString(),
      lastNotifiedVersion: '0.33.0',
      lastNotifiedAt: NOW.toISOString(),
    });
  });

  it('fresh cache + newer version unseen → notify only, no refresh', () => {
    const cache: UpdateCache = { latestVersion: '0.33.0', lastCheckedAt: hoursAgo(1) };
    const plan = planUpdateActions(cache, '0.32.0', NOW);
    expect(plan.notify).toBe(true);
    expect(plan.refresh).toBe(false);
    expect(plan.nextCache).toEqual({
      latestVersion: '0.33.0',
      lastCheckedAt: hoursAgo(1),
      lastNotifiedVersion: '0.33.0',
      lastNotifiedAt: NOW.toISOString(),
    });
  });
});

describe('visualWidth / padToWidth', () => {
  it('counts ASCII as width 1', () => {
    expect(visualWidth('abc')).toBe(3);
  });
  it('counts CJK as width 2', () => {
    expect(visualWidth('中文')).toBe(4);
  });
  it('counts arrows ↑ → as width 1', () => {
    expect(visualWidth('↑→')).toBe(2);
  });
  it('handles mixed CJK + ASCII', () => {
    expect(visualWidth('omk 升级')).toBe(4 /* omk_ */ + 4 /* 升级 */);
  });
  it('is surrogate-pair safe', () => {
    expect(visualWidth('a😀b')).toBe(3); // emoji outside wide ranges → 1
  });
  it('pads to the target visual width', () => {
    expect(visualWidth(padToWidth('中', 6))).toBe(6);
    expect(visualWidth(padToWidth('abc', 6))).toBe(6);
  });
  it('leaves over-wide strings untouched', () => {
    expect(padToWidth('中文', 2)).toBe('中文');
  });
});

describe('renderUpdateBox', () => {
  const parts = {
    current: '0.32.0',
    latest: '0.33.0',
    upgradeCmd: 'npm i -g oh-my-knowledge@latest',
    silenceHint: 'OMK_SKIP_UPDATE_CHECK=1',
  };

  it('aligns every body line to equal visual width (right border lines up)', () => {
    const box = renderUpdateBox(parts, 'zh');
    const bodyLines = box.split('\n').filter((l) => l.startsWith('│'));
    expect(bodyLines.length).toBe(4);
    const widths = new Set(bodyLines.map(visualWidth));
    expect(widths.size).toBe(1);
  });

  it('draws box-drawing borders', () => {
    const box = renderUpdateBox(parts, 'zh');
    expect(box).toContain('┌');
    expect(box).toContain('└');
    expect(box).toContain('│');
  });

  it('matches snapshot (zh)', () => {
    expect(renderUpdateBox(parts, 'zh')).toMatchSnapshot();
  });

  it('matches snapshot (en)', () => {
    expect(renderUpdateBox(parts, 'en')).toMatchSnapshot();
  });
});

describe('renderNotice (TTY vs pipe branch)', () => {
  const parts = {
    current: '0.32.0',
    latest: '0.33.0',
    upgradeCmd: 'npm i -g oh-my-knowledge@latest',
    silenceHint: 'OMK_SKIP_UPDATE_CHECK=1',
  };

  it('renders the multi-line box on a TTY', () => {
    const out = renderNotice(parts, 'oh-my-knowledge', 'zh', true);
    expect(out).toContain('┌');
    expect(out.split('\n').filter((l) => l.startsWith('│')).length).toBe(4);
  });

  it('falls back to a single line off a TTY (no box chars)', () => {
    const out = renderNotice(parts, 'oh-my-knowledge', 'zh', false);
    expect(out).not.toContain('┌');
    expect(out).not.toContain('│');
    expect(out.trim().split('\n').length).toBe(1);
  });

  it('the fallback line carries the new upgrade command (guards the rename)', () => {
    expect(renderNotice(parts, 'oh-my-knowledge', 'zh', false)).toContain('npm i -g oh-my-knowledge@latest');
    expect(renderNotice(parts, 'oh-my-knowledge', 'en', false)).toContain('npm i -g oh-my-knowledge@latest');
  });
});

describe('spawnDetached (fail-silent on child startup error)', () => {
  beforeEach(() => spawnMock.mockReset());

  it('detaches + unrefs the child', () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnMock.mockReturnValue(child);
    spawnDetached('/x/worker.js', ['a', 'b']);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/x/worker.js', 'a', 'b'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('swallows the async error event (no listener would throw)', () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnMock.mockReturnValue(child);
    spawnDetached('/x/worker.js', []);
    // EventEmitter 没有 error listener 时 emit('error') 会同步抛;挂了 handler 才静默
    expect(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))).not.toThrow();
  });
});
