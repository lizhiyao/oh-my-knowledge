/**
 * 升级检查的后台刷新 worker。由 update-check.ts 的 fetchAndStore 以 detached + unref
 * spawn,独立于父 CLI 进程运行:抓 registry latest 写回
 * ~/.oh-my-knowledge/state/cache/update-check.json,
 * 供下次运行展示用。父进程不等它,所以这里阻塞式 await fetch 没关系。全程 fail-silent。
 *
 * argv: [node, update-fetch-worker.js, cachePath, registry, pkgName]
 */
import { readCache, writeCache } from './update-check.js';

async function main(): Promise<void> {
  const [cachePath, registry, name] = process.argv.slice(2);
  if (!cachePath || !registry || !name) return;
  try {
    const res = await fetch(`${registry.replace(/\/$/, '')}/${name}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    if (!data.version) return;
    const prev = readCache(cachePath); // 重读以保留展示侧写的 notify 节流字段,别覆盖
    writeCache(cachePath, {
      latestVersion: data.version,
      lastCheckedAt: new Date().toISOString(),
      lastNotifiedVersion: prev?.lastNotifiedVersion,
      lastNotifiedAt: prev?.lastNotifiedAt,
    });
  } catch {
    /* 静默:网络 / 超时 / 解析 / 磁盘任一失败都不影响 */
  }
}

void main();
