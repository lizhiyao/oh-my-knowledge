import { describe, it, vi, beforeEach, expect } from 'vitest';

/**
 * 回归: `omk bench report --dev` 把 `cliPath` 当 child entrypoint 传给 spawn。
 * 命令模块化后,如果用 `import.meta.url` 直接当 cliPath, 它会指向
 * `commands/report.js` — 那个 module 只 export `execute`, 没 `main()`,
 * child 会立刻退出, --dev 静默坏掉。child entrypoint 必须是 `cli/index.js`。
 */

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

describe('bench report --dev: child spawn argv', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    delete process.env.__OMK_DEV_CHILD;
  });

  it('child entrypoint is cli/index.js, not commands/report.js', async () => {
    const { execute } = await import('../../src/cli/commands/report.js');
    await execute(['--dev']);

    expect(spawnCalls).toHaveLength(1);
    // child argv: ['--watch-path', libDir, cliPath, 'bench', 'report', ...]
    const [, libDir, cliPath] = spawnCalls[0].args;
    expect(cliPath).toMatch(/[\\/]cli[\\/]index\.(js|ts)$/);
    expect(cliPath).not.toMatch(/[\\/]commands[\\/]/);
    // libDir 必须是真实存在的目录(否则 node --watch-path 静默不 watch),
    // 不能是历史 bug 里的 dist/src/cli/lib (那个目录不存在)。
    expect(libDir).not.toMatch(/[\\/]commands[\\/]/);
    expect(libDir).not.toMatch(/[\\/]lib$/);
  });
});
