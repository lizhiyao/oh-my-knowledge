/**
 * 门禁自守：src/ 下不允许存在没有超时上限的同步子进程调用。
 *
 * execFileSync／spawnSync／execSync 会阻塞事件循环，期间的超时不是 Node 说了算就能救回来：
 * 调用方拿不到控制权，vitest 的 testTimeout／hookTimeout 打不响，CLI 也只会跟着一起挂住。
 * 一次卡住的 git（凭据提示读 /dev/tty、仓库落在 NFS 挂载上、慢盘）因此表现为「命令永久不返回」，
 * 而不是 fail-closed 的错误。这类缺陷在本地永远复现不出来，所以把它变成静态断言。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_DIR = join(REPO_ROOT, 'src');
const SYNC_SUBPROCESS_CALLS = new Set(['execFileSync', 'spawnSync', 'execSync']);

interface SyncCall {
  file: string;
  line: number;
  name: string;
  /** options 不是内联对象字面量时无法静态证明有界，按未定界处理。 */
  bounded: boolean;
}

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collectSources(path, out);
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

function optionsOf(node: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  for (let index = node.arguments.length - 1; index >= 0; index -= 1) {
    const argument = node.arguments[index];
    if (ts.isObjectLiteralExpression(argument)) return argument;
  }
  return undefined;
}

function hasTimeout(options: ts.ObjectLiteralExpression): boolean {
  return options.properties.some((property) => {
    const name = property.name;
    if (name === undefined) return false;
    return ts.isIdentifier(name) && name.text === 'timeout';
  });
}

function inspectFile(path: string): SyncCall[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true);
  const found: SyncCall[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && SYNC_SUBPROCESS_CALLS.has(node.expression.text)) {
      const options = optionsOf(node);
      found.push({
        file: relative(REPO_ROOT, path),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        name: node.expression.text,
        bounded: options !== undefined && hasTimeout(options),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

describe('同步子进程调用必须定界', () => {
  const calls = collectSources(SRC_DIR).flatMap(inspectFile);

  it('扫描确实覆盖了 src/ 的同步子进程调用', () => {
    // 断言扫描非空，否则「无违规」可能只是因为什么都没扫到（与 #861 的 .tsx 假绿同类风险）。
    expect(calls.length, JSON.stringify(calls)).toBeGreaterThanOrEqual(8);
  });

  it('src/ 下不存在缺少 timeout 的 execFileSync／spawnSync／execSync', () => {
    expect(calls.filter((call) => !call.bounded).map((call) => `${call.file}:${call.line} ${call.name}`)).toEqual([]);
  });
});
