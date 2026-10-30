import { EventEmitter } from 'node:events';
import { describe, it, vi, beforeEach, afterEach, expect } from 'vitest';
import { runCommand } from '../helpers/run-command.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CapturedSpawn {
  command: string;
  args: string[];
}

interface CapturedExecFile {
  command: string;
  args: string[];
}

const spawnCalls: CapturedSpawn[] = [];
const execFileCalls: CapturedExecFile[] = [];
const roots: string[] = [];
let platformName = 'darwin';
let execFileError: Error | null = null;
let spawnError: Error | null = null;
let holdChild = false;
let killed = 0;
let studioUrl = 'http://127.0.0.1:7799';
let networkUrls: string[] = [];

const originalStdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

function restoreStdoutIsTTY(): void {
  if (originalStdoutIsTty) {
    Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTty);
  } else {
    Reflect.deleteProperty(process.stdout, 'isTTY');
  }
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    const child = Object.assign(new EventEmitter(), {
      kill: () => { killed += 1; queueMicrotask(() => child.emit('close', null)); return true; },
    });
    queueMicrotask(() => {
      if (spawnError) child.emit('error', spawnError);
      else if (!holdChild) child.emit('close', 0);
    });
    return child;
  }),
  execFile: vi.fn((command: string, args: string[], callback: (err: Error | null) => void) => {
    execFileCalls.push({ command, args });
    callback(execFileError);
    return { on: () => undefined };
  }),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    platform: vi.fn(() => platformName),
  };
});

vi.mock('../../src/studio/http/next-server.js', () => ({
  createNextStudioServer: vi.fn(() => ({
    start: vi.fn(async () => studioUrl),
    getAddresses: vi.fn(() => ({ bindAddress: `0.0.0.0:${new URL(studioUrl).port}`, url: studioUrl, networkUrls })),
    stop: vi.fn(async () => undefined),
  })),
}));

describe('studio --dev child spawn argv', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    execFileCalls.length = 0;
    execFileError = null;
    spawnError = null;
    holdChild = false;
    killed = 0;
    studioUrl = 'http://127.0.0.1:7799';
    networkUrls = [];
    platformName = 'darwin';
    delete process.env.__OMK_DEV_CHILD;
    delete process.env.BROWSER;
    setStdoutIsTTY(false);
  });

  afterEach(() => {
    restoreStdoutIsTTY();
    vi.clearAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('uses cli/index.js as child entrypoint and re-enters studio', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const root = mkdtempSync(join(tmpdir(), 'omk-studio-source-scope-')); roots.push(root);
    const path = join(root, 'scope.json'); writeFileSync(path, JSON.stringify({ scopeVersion: 'knowledge-source-scope/v1', projects: [], traces: [] }));
    await runStudio({}, {
      lang: 'zh',
      global: false,
      port: '8080',
      host: '0.0.0.0',
      takeover: true,
      'reports-dir': 'tmp-reports',
      'source-scope': path,
      'no-open': true,
      dev: true,
    }, 'zh');

    expect(spawnCalls).toHaveLength(1);
    const [, watchRoot, cliPath, command, ...rest] = spawnCalls[0].args;
    expect(watchRoot).not.toMatch(/[\\/]commands[\\/]/);
    expect(watchRoot).not.toMatch(/[\\/]lib$/);
    expect(cliPath).toMatch(/[\\/]cli[\\/]index\.(js|ts)$/);
    expect(cliPath).not.toMatch(/[\\/]commands[\\/]/);
    expect(command).toBe('studio');
    expect(rest).toEqual(['--port', '8080', '--lang', 'zh', '--host', '0.0.0.0', '--takeover', '--reports-dir', 'tmp-reports', '--source-scope', path, '--no-open']);
  });

  it('injects only parsed startup source scope and refuses malformed scope before server construction', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const { createNextStudioServer } = await import('../../src/studio/http/next-server.js');
    const root = mkdtempSync(join(tmpdir(), 'omk-studio-trusted-scope-')); roots.push(root);
    const scope = { scopeVersion: 'knowledge-source-scope/v1', projects: [{ projectId: 'project', root }], traces: [] }, path = join(root, 'scope.json'); writeFileSync(path, JSON.stringify(scope));
    const flags = { lang: 'zh' as const, global: false, takeover: false, port: '7799', 'no-open': true, dev: false, 'source-scope': path };
    await runStudio({}, flags, 'zh'); expect(vi.mocked(createNextStudioServer).mock.calls.at(-1)?.[0]?.sourceScope).toEqual(scope);
    vi.mocked(createNextStudioServer).mockClear(); writeFileSync(path, '{invalid');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { await expect(runStudio({}, flags, 'zh')).rejects.toMatchObject({ code: 2 }); expect(createNextStudioServer).not.toHaveBeenCalled(); }
    finally { stderr.mockRestore(); }
  });

  it('启动错误通过命令边界返回，不变成未捕获事件', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    spawnError = new Error('spawn EACCES');
    await expect(runStudio({}, { lang: 'en', global: false, takeover: false, port: '7799', 'no-open': true, dev: true }, 'en')).rejects.toThrow('spawn EACCES');
    expect(spawnCalls[0].args).toContain('en');
  });

  it('取消开发宿主会终止子进程并等待关闭', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const cancellation = new AbortController();
    holdChild = true;
    const run = runStudio({}, { lang: 'zh', global: false, takeover: false, port: '7799', 'no-open': true, dev: true }, 'zh', cancellation.signal);
    const outcome = expect(run).rejects.toMatchObject({ code: 1 });
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    cancellation.abort();
    await outcome;
    expect(killed).toBe(1);
  });

  it('取消服务宿主会等待 server.stop 完成', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const { createNextStudioServer } = await import('../../src/studio/http/next-server.js');
    const cancellation = new AbortController();
    const run = runStudio({}, { lang: 'zh', global: false, takeover: false, port: '7799', 'no-open': true, dev: false }, 'zh', cancellation.signal);
    await vi.waitFor(() => expect(createNextStudioServer).toHaveBeenCalled());
    cancellation.abort();
    await run;
    expect(vi.mocked(createNextStudioServer).mock.results.at(-1)?.value.stop).toHaveBeenCalledOnce();
  });

  it('默认(无 --reports-dir)→ 子进程 argv 不带 --reports-dir(交给 server 建 overlay)', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    await runStudio({}, {
      lang: 'zh',
      global: false,
      takeover: false,
      port: '7799',
      'no-open': true,
      dev: true,
    }, 'zh');

    expect(spawnCalls).toHaveLength(1);
    const [, , , , ...rest] = spawnCalls[0].args;
    expect(rest).toEqual(['--port', '7799', '--lang', 'zh', '--no-open']);
    expect(rest).not.toContain('--reports-dir');
  });

  it('--global → 子进程 argv 透传 --global(reports / observe-health / doctors 钉全局)', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    await runStudio({}, {
      lang: 'zh',
      global: true,
      takeover: false,
      port: '7799',
      'no-open': true,
      dev: true,
    }, 'zh');

    expect(spawnCalls).toHaveLength(1);
    const [, , , , ...rest] = spawnCalls[0].args;
    expect(rest).toEqual(['--port', '7799', '--lang', 'zh', '--global', '--no-open']);
  });

  it('server 模式 --global → observationsDir 钉全局(与 observe-health / doctors 一致)', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const { createNextStudioServer } = await import('../../src/studio/http/next-server.js');
    const { globalObservationsDir } = await import('../../src/observability/inbox/index.js');
    await runStudio({}, { lang: 'zh', global: true, takeover: false, port: '7799', 'no-open': true, dev: false }, 'zh');
    const opts = vi.mocked(createNextStudioServer).mock.calls.at(-1)?.[0];
    expect(opts?.observationsDir).toBe(globalObservationsDir());
  });

  it('server 模式默认(无 --global / --observations-dir）→ observationsDir 不设(交给 server 项目优先+全局兜底)', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const { createNextStudioServer } = await import('../../src/studio/http/next-server.js');
    await runStudio({}, { lang: 'zh', global: false, takeover: false, port: '7799', 'no-open': true, dev: false }, 'zh');
    const opts = vi.mocked(createNextStudioServer).mock.calls.at(-1)?.[0];
    expect(opts?.observationsDir).toBeUndefined();
    expect(opts?.takeover).toBe(false);
    expect(opts?.coreStudioCatalog).toMatchObject({
      list: expect.any(Function), get: expect.any(Function), inspect: expect.any(Function),
    });
  });

  it('wires explicit takeover and prints actual bound/access URLs without using the requested port', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const { createNextStudioServer } = await import('../../src/studio/http/next-server.js');
    studioUrl = 'http://127.0.0.1:58123';
    networkUrls = ['http://192.0.2.8:58123'];
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runStudio({}, { lang: 'zh', global: false, port: '0', host: '0.0.0.0', takeover: true, 'no-open': true, dev: false }, 'zh');
      expect(vi.mocked(createNextStudioServer).mock.calls.at(-1)?.[0]).toMatchObject({ port: 0, host: '0.0.0.0', takeover: true });
      expect(output.mock.calls).toContainEqual(['studio 已启动：http://127.0.0.1:58123']);
      expect(output.mock.calls).toContainEqual(['实际监听：0.0.0.0:58123']);
      expect(output.mock.calls).toContainEqual(['网卡候选地址：http://192.0.2.8:58123（访问取决于路由与防火墙）']);
    } finally { output.mockRestore(); }
  });

  it('parses takeover through the real command lifecycle without enabling it by default', async () => {
    const { default: Studio } = await import('../../src/cli/commands/studio.js');
    const { createNextStudioServer } = await import('../../src/studio/http/next-server.js');
    for (const takeover of [false, true]) {
      vi.mocked(createNextStudioServer).mockImplementationOnce(() => ({
        start: vi.fn(async () => { throw new Error('isolated listen failure'); }),
        stop: vi.fn(async () => undefined),
        getUrl: vi.fn(() => null),
        getAddresses: vi.fn(() => null),
      }));
      await expect(runCommand(Studio, ['--port', '0', '--host', '0.0.0.0', '--no-open', ...(takeover ? ['--takeover'] : [])]))
        .rejects.toMatchObject({ code: 1 });
      expect(vi.mocked(createNextStudioServer).mock.calls.at(-1)?.[0]).toMatchObject({ port: 0, host: '0.0.0.0', takeover });
    }
  });

  it('treats BROWSER=none as no browser open', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    process.env.BROWSER = 'none';

    await runStudio({}, { lang: 'zh', global: false, takeover: false, port: '7799', 'no-open': false, dev: false }, 'zh');

    expect(execFileCalls).toHaveLength(0);
  });

  it('uses cmd start for the default Windows browser opener', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    platformName = 'win32';

    await runStudio({}, { lang: 'zh', global: false, takeover: false, port: '7799', 'no-open': false, dev: false }, 'zh');

    expect(execFileCalls).toEqual([
      { command: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:7799'] },
    ]);
  });

  it('warns when browser auto-open fails', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    platformName = 'linux';
    execFileError = new Error('xdg-open missing');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await runStudio({}, { lang: 'zh', global: false, takeover: false, port: '7799', 'no-open': false, dev: false }, 'zh');

      expect(execFileCalls).toEqual([
        { command: 'xdg-open', args: ['http://127.0.0.1:7799'] },
      ]);
      expect(stderr.mock.calls.some((call) => String(call[0]).includes('无法自动打开浏览器'))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});
