import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const usage = '用法：yarn ci:quick <test/路径.test.ts 或 .test.tsx> [...]（必须显式指定已有测试文件）';

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return 0;
  }
  let files;
  try {
    if (!args.length) throw new Error('未指定测试文件');
    files = [...new Set(args.map(arg => {
      if (arg.startsWith('-')) throw new Error(`不接受测试选项：${arg}`);
      const file = realpathSync(resolve(root, arg));
      const path = relative(root, file).split(sep).join('/');
      if (isAbsolute(path) || !/^test\/.+\.test\.tsx?$/.test(path) || !statSync(file).isFile()) {
        throw new Error(`必须指定仓库 test/ 内的测试文件：${arg}`);
      }
      return path;
    }))];
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  const yarn = process.env.npm_execpath;
  if (!yarn) {
    console.error(`请通过 Yarn 执行。${usage}`);
    return 2;
  }
  console.log('[ci:quick] 仅执行静态检查与指定测试；不构建产物，不代表完整 CI 通过。');
  for (const args of [['lint'], ['typecheck'], ['test', ...files]]) {
    const start = performance.now();
    const result = spawnSync(yarn, args, { cwd: root, stdio: 'inherit' });
    console.log(`[ci:quick] ${args[0]}：${((performance.now() - start) / 1000).toFixed(2)} 秒`);
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

process.exitCode = main();
