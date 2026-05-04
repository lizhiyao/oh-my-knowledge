import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const COMMANDS_DIR = join(PROJECT_ROOT, 'src', 'cli', 'commands');
const INDEX_PATH = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');

/**
 * 防止 `commands/<name>.ts` 文件存在但 index.ts 没接 import / dispatch case。
 * 拆 17 个 command 后,新增 / 移动 module 时容易漏接 — 这层 smoke 兜底。
 *
 * 不验证 case 名 (有的命令走 domain 分支不在 switch 里,如 analyze/doctor),
 * 只验证 import 行存在 — 漏 import 时 TS 编译会报错,这里再加一层断言。
 */
describe('CLI dispatcher routing', () => {
  it('every commands/<name>.ts (除 _shared) 都被 index.ts 引用', () => {
    const indexSrc = readFileSync(INDEX_PATH, 'utf-8');
    const files = readdirSync(COMMANDS_DIR)
      .filter((f) => f.endsWith('.ts') && !f.startsWith('_'));

    expect(files.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const file of files) {
      const name = file.replace(/\.ts$/, '');
      const importRe = new RegExp(`from\\s+['"]\\./commands/${name}\\.js['"]`);
      if (!importRe.test(indexSrc)) missing.push(name);
    }
    expect(missing, `commands modules missing from index.ts: ${missing.join(', ')}`).toEqual([]);
  });
});
