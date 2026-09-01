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
    return { on: () => undefined };
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

vi.mock('../../src/studio/http/report-server.js', () => ({
  createReportServer: vi.fn(() => ({
    start: vi.fn(async () => 'http://127.0.0.1:7799'),
  })),
}));

describe('studio --dev child spawn argv', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    execFileCalls.length = 0;
    execFileError = null;
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
    expect(rest).toEqual(['--port', '8080', '--reports-dir', 'tmp-reports', '--no-open']);
  });

  it('默认(无 --reports-dir)→ 子进程 argv 不带 --reports-dir(交给 server 建 overlay)', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    await runStudio({}, {
      lang: 'zh',
      port: '7799',
      'no-open': true,
      dev: true,
    }, 'zh');

    expect(spawnCalls).toHaveLength(1);
    const [, , , , ...rest] = spawnCalls[0].args;
    expect(rest).toEqual(['--port', '7799', '--no-open']);
    expect(rest).not.toContain('--reports-dir');
  });

  it('--global → 子进程 argv 透传 --global(reports / observe-health / doctors 钉全局)', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    await runStudio({}, {
      lang: 'zh',
      port: '7799',
      'no-open': true,
      dev: true,
      global: true,
    }, 'zh');

    expect(spawnCalls).toHaveLength(1);
    const [, , , , ...rest] = spawnCalls[0].args;
    expect(rest).toEqual(['--port', '7799', '--global', '--no-open']);
  });

  it('server 模式 --global → observationsDir 钉全局(与 observe-health / doctors 一致)', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const { createReportServer } = await import('../../src/studio/http/report-server.js');
    const { DEFAULT_GLOBAL_OBSERVATIONS_DIR } = await import('../../src/observability/inbox.js');
    await runStudio({}, { lang: 'zh', port: '7799', 'no-open': true, dev: false, global: true }, 'zh');
    const opts = vi.mocked(createReportServer).mock.calls.at(-1)?.[0];
    expect(opts?.observationsDir).toBe(DEFAULT_GLOBAL_OBSERVATIONS_DIR);
  });

  it('server 模式默认(无 --global / --observations-dir）→ observationsDir 不设(交给 server 项目优先+全局兜底)', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    const { createReportServer } = await import('../../src/studio/http/report-server.js');
    await runStudio({}, { lang: 'zh', port: '7799', 'no-open': true, dev: false }, 'zh');
    const opts = vi.mocked(createReportServer).mock.calls.at(-1)?.[0];
    expect(opts?.observationsDir).toBeUndefined();
  });

  it('treats BROWSER=none as no browser open', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    process.env.BROWSER = 'none';

    await runStudio({}, { lang: 'zh', port: '7799', 'no-open': false, dev: false }, 'zh');

    expect(execFileCalls).toHaveLength(0);
  });

  it('uses cmd start for the default Windows browser opener', async () => {
    const { runStudio } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    platformName = 'win32';

    await runStudio({}, { lang: 'zh', port: '7799', 'no-open': false, dev: false }, 'zh');

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
      await runStudio({}, { lang: 'zh', port: '7799', 'no-open': false, dev: false }, 'zh');

      expect(execFileCalls).toEqual([
        { command: 'xdg-open', args: ['http://127.0.0.1:7799'] },
      ]);
      expect(stderr.mock.calls.some((call) => String(call[0]).includes('无法自动打开浏览器'))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});
