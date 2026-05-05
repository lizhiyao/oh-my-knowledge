import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_COMMANDS } from '../../src/cli/commands/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(__dirname, '..', '..', 'src', 'cli', 'commands');

/**
 * 防止 `commands/<name>.ts` 文件重新长出旧入口。只有产品级命令能被
 * PRODUCT_COMMANDS 暴露；eval-* / improve-* / export-* 是产品命令内部实现模块。
 *
 * `_*` (如 _shared) 是内部 module, registry.ts 自己也排除。
 */
describe('CLI dispatcher routing', () => {
  it('commands 目录只保留产品命令和产品内部实现模块', () => {
    const files = readdirSync(COMMANDS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => !f.startsWith('_') && f !== 'registry.ts')
      .map((f) => f.replace(/\.ts$/, ''));

    const product = new Set(Object.keys(PRODUCT_COMMANDS));
    const implementationOnly = files.filter((name) =>
      name.startsWith('eval-') || name.startsWith('improve-') || name.startsWith('export-'));
    const publicFiles = files.filter((name) => !implementationOnly.includes(name));

    expect(publicFiles.sort()).toEqual([...product].sort());
    expect(files).not.toEqual(expect.arrayContaining([
      'analyze',
      'debias-validate',
      'diagnose',
      'diff',
      'evolve',
      'failures',
      'gate',
      'gen-samples',
      'gold',
      'report',
      'run',
      'saturation',
      'verdict',
    ]));
  });

  it('产品级命令只暴露用户工作流入口', () => {
    expect(Object.keys(PRODUCT_COMMANDS).sort()).toEqual([
      'doctor',
      'eval',
      'export',
      'improve',
      'init',
      'observe',
      'studio',
    ]);
    for (const oldEntry of ['bench', 'analyze', 'diagnose', 'failures', 'verdict']) {
      expect(PRODUCT_COMMANDS).not.toHaveProperty(oldEntry);
    }
  });

  it('registry 里每个 entry 都有可调用的 execute', () => {
    for (const [name, cmd] of Object.entries(PRODUCT_COMMANDS)) {
      expect(typeof cmd.execute, `${name}.execute should be a function`).toBe('function');
    }
  });
});
