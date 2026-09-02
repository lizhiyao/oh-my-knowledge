/**
 * 回归:stale cache 下升级检查的后台刷新不能拖住 CLI 退出。
 *
 * 起一个只 accept、永不应答的本地 TCP server 当 registry —— 若刷新走父进程内的 fetch,
 * 进程会被网络 handle 拖到 3s abort 才退；现在刷新丢给 detached + unref 子进程,父进程发完
 * spawn 立即返回。用一个非短路径命令(doctor 指向不存在的 skill,快速失败)触发 checkUpdate,
 * 断言整体退出远早于 3s abort。子进程在后台自行 3s 超时退出,execFileAsync 只等父进程。
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

const EXIT_BUDGET_MS = 2500; // 远低于 worker 的 3000ms abort;命令本身快速失败,余量挡掉退出被拖的回归

let server: Server;
let port: number;
const sockets = new Set<Socket>();

beforeAll(async () => {
  // 只 accept、不回应:HTTP 请求会一直挂着,直到客户端 abort
  server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sockets.delete(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  for (const s of sockets) s.destroy();
  server.close();
});

describe('update check background refresh must not delay CLI exit', () => {
  it(`stale cache + 黑洞 registry 下,非短路径命令仍在 ${EXIT_BUDGET_MS}ms 内退出`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'omk-exit-'));
    const cacheDir = join(home, '.oh-my-knowledge', 'state', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    // stale(lastCheckedAt 很旧)→ 触发刷新;latestVersion 很低 → 不触发提示,只测退出时延
    writeFileSync(
      join(cacheDir, 'update-check.json'),
      JSON.stringify({ latestVersion: '0.0.1', lastCheckedAt: '2020-01-01T00:00:00.000Z' }),
    );

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, npm_config_registry: `http://127.0.0.1:${port}/` };
    delete env.NODE_ENV; // 否则 shouldSkipUpdateCheck 直接跳过,测不到刷新路径
    delete env.CI;
    delete env.OMK_SKIP_UPDATE_CHECK;

    const t0 = Date.now();
    try {
      // doctor 指向不存在的 skill,快速失败(exit 1);execFileAsync 因非零退出 reject,计时照常
      await execFileAsync('node', [CLI, 'doctor', join(home, 'no-such-skill')], { env });
    } catch {
      /* 预期非零退出,忽略 */
    }
    const ms = Date.now() - t0;
    rmSync(home, { recursive: true, force: true });

    assert.ok(
      ms < EXIT_BUDGET_MS,
      `CLI took ${ms}ms to exit with a stalling registry; expected < ${EXIT_BUDGET_MS}ms (regression: background refresh must be detached, not an in-process fetch holding the event loop)`,
    );
  }, 20000);
});
