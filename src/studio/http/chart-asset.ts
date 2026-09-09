import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

let cachedChartJsBytes: string | null | undefined;
export function loadChartJsBundle(): string | null {
  if (cachedChartJsBytes !== undefined) return cachedChartJsBytes;
  try {
    // chart.js 的 exports 字段不允许直接 resolve 子路径,先 resolve 主入口拿到包目录,
    // 再拼到 dist/chart.umd.min.js(这个 UMD 在 sideEffects 里声明,实际存在)。
    const req = createRequire(import.meta.url);
    const mainPath = req.resolve('chart.js');
    const distDir = mainPath.replace(/[/\\]chart\.cjs$/, '').replace(/[/\\]chart\.js$/, '');
    const umdPath = join(distDir, 'chart.umd.min.js');
    cachedChartJsBytes = readFileSync(umdPath, 'utf-8');
  } catch {
    cachedChartJsBytes = null;
  }
  return cachedChartJsBytes;
}

