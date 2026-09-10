import { EventEmitter } from 'node:events';
import { describe, it, vi, beforeEach, afterEach, expect } from 'vitest';

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
let platformName = 'darwin';
let execFileError: Error | null = null;
let spawnError: Error | null = null;
let holdChild = false;
let killed = 0;

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
    start: vi.fn(async () => 'http://127.0.0.1:7799'),
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
    platformName = 'darwin';
    delete process.env.__OMK_DEV_CHILD;
    delete process.env.BROWSER;
    setStdoutIsTTY(false);
  });

  afterEach(() => {
    restoreStdoutIsTTY();
    vi.clearAllMocks();
  });

  it('uses cli/index.js as child entrypoint and re-enters studio', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    await runStudio({}, {
      lang: 'zh',
      global: false,
      port: '8080',
      'reports-dir': 'tmp-reports',
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
    expect(rest).toEqual(['--port', '8080', '--lang', 'zh', '--reports-dir', 'tmp-reports', '--no-open']);
  });

  it('启动错误通过命令边界返回，不变成未捕获事件', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    spawnError = new Error('spawn EACCES');
    await expect(runStudio({}, { lang: 'en', global: false, port: '7799', 'no-open': true, dev: true }, 'en')).rejects.toThrow('spawn EACCES');
    expect(spawnCalls[0].args).toContain('en');
  });

  it('取消开发宿主会终止子进程并等待关闭', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const cancellation = new AbortController();
    holdChild = true;
    const run = runStudio({}, { lang: 'zh', global: false, port: '7799', 'no-open': true, dev: true }, 'zh', cancellation.signal);
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
    const run = runStudio({}, { lang: 'zh', global: false, port: '7799', 'no-open': true, dev: false }, 'zh', cancellation.signal);
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
    const { DEFAULT_GLOBAL_OBSERVATIONS_DIR } = await import('../../src/observability/inbox/index.js');
    await runStudio({}, { lang: 'zh', global: true, port: '7799', 'no-open': true, dev: false }, 'zh');
    const opts = vi.mocked(createNextStudioServer).mock.calls.at(-1)?.[0];
    expect(opts?.observationsDir).toBe(DEFAULT_GLOBAL_OBSERVATIONS_DIR);
  });

  it('server 模式默认(无 --global / --observations-dir）→ observationsDir 不设(交给 server 项目优先+全局兜底)', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const { createNextStudioServer } = await import('../../src/studio/http/next-server.js');
    await runStudio({}, { lang: 'zh', global: false, port: '7799', 'no-open': true, dev: false }, 'zh');
    const opts = vi.mocked(createNextStudioServer).mock.calls.at(-1)?.[0];
    expect(opts?.observationsDir).toBeUndefined();
    expect(opts?.coreStudioCatalog).toMatchObject({
      list: expect.any(Function), get: expect.any(Function), inspect: expect.any(Function),
    });
  });

  it('treats BROWSER=none as no browser open', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    process.env.BROWSER = 'none';

    await runStudio({}, { lang: 'zh', global: false, port: '7799', 'no-open': false, dev: false }, 'zh');

    expect(execFileCalls).toHaveLength(0);
  });

  it('uses cmd start for the default Windows browser opener', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    platformName = 'win32';

    await runStudio({}, { lang: 'zh', global: false, port: '7799', 'no-open': false, dev: false }, 'zh');

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
      await runStudio({}, { lang: 'zh', global: false, port: '7799', 'no-open': false, dev: false }, 'zh');

      expect(execFileCalls).toEqual([
        { command: 'xdg-open', args: ['http://127.0.0.1:7799'] },
      ]);
      expect(stderr.mock.calls.some((call) => String(call[0]).includes('无法自动打开浏览器'))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});
