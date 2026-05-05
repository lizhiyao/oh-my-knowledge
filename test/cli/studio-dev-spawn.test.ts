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

vi.mock('../../src/server/report-server.js', () => ({
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
    const { execute } = await import('../../src/cli/commands/studio.js');
    await execute(['--dev', '--port', '8080', '--reports-dir', 'tmp-reports', '--no-open']);

    expect(spawnCalls).toHaveLength(1);
    const [, watchRoot, cliPath, command, ...rest] = spawnCalls[0].args;
    expect(watchRoot).not.toMatch(/[\\/]commands[\\/]/);
    expect(watchRoot).not.toMatch(/[\\/]lib$/);
    expect(cliPath).toMatch(/[\\/]cli[\\/]index\.(js|ts)$/);
    expect(cliPath).not.toMatch(/[\\/]commands[\\/]/);
    expect(command).toBe('studio');
    expect(rest).toEqual(['--port', '8080', '--reports-dir', 'tmp-reports', '--no-open']);
  });

  it('treats BROWSER=none as no browser open', async () => {
    const { execute } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    process.env.BROWSER = 'none';

    await execute([]);

    expect(execFileCalls).toHaveLength(0);
  });

  it('uses cmd start for the default Windows browser opener', async () => {
    const { execute } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    platformName = 'win32';

    await execute([]);

    expect(execFileCalls).toEqual([
      { command: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:7799'] },
    ]);
  });

  it('warns when browser auto-open fails', async () => {
    const { execute } = await import('../../src/cli/commands/studio.js');
    setStdoutIsTTY(true);
    platformName = 'linux';
    execFileError = new Error('xdg-open missing');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await execute([]);

      expect(execFileCalls).toEqual([
        { command: 'xdg-open', args: ['http://127.0.0.1:7799'] },
      ]);
      expect(stderr.mock.calls.some((call) => String(call[0]).includes('无法自动打开浏览器'))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});
