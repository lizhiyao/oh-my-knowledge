import { describe, it, vi, beforeEach, expect } from 'vitest';

interface CapturedSpawn {
  command: string;
  args: string[];
}

const spawnCalls: CapturedSpawn[] = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    return { on: () => undefined };
  }),
}));

describe('studio --dev child spawn argv', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    delete process.env.__OMK_DEV_CHILD;
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
});
