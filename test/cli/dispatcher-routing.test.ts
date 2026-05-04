import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_COMMANDS, DOMAIN_COMMANDS } from '../../src/cli/commands/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(__dirname, '..', '..', 'src', 'cli', 'commands');

/**
 * 防止 `commands/<name>.ts` 文件存在但 registry 没接上。新增命令时只要忘
 * 加 registry entry, 这层就 fail — 比靠 review 抓更稳。
 *
 * `_*` (如 _shared) 是内部 module, registry.ts 自己也排除。
 */
describe('CLI dispatcher routing', () => {
  it('每个 commands/<name>.ts 都注册在 BENCH 或 DOMAIN', () => {
    const files = readdirSync(COMMANDS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => !f.startsWith('_') && f !== 'registry.ts')
      .map((f) => f.replace(/\.ts$/, ''));

    const registered = new Set([
      ...Object.keys(BENCH_COMMANDS),
      ...Object.keys(DOMAIN_COMMANDS),
    ]);

    const missing = files.filter((name) => !registered.has(name));
    expect(missing, `commands files not in registry: ${missing.join(', ')}`).toEqual([]);
  });

  it('registry 里每个 entry 都有可调用的 execute', () => {
    const all = [...Object.entries(BENCH_COMMANDS), ...Object.entries(DOMAIN_COMMANDS)];
    for (const [name, cmd] of all) {
      expect(typeof cmd.execute, `${name}.execute should be a function`).toBe('function');
    }
  });
});
