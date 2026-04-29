import { tCli, type CliLang } from './i18n.js';

export async function checkUpdate(lang: CliLang): Promise<void> {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __dirname: string = dirname(fileURLToPath(import.meta.url));
    // 从当前文件位置向上找 package.json:dev 跑 src/cli/ 时 3 层到根,
    // 装到 npm 跑 dist/src/cli/ 时 4 层到 oh-my-knowledge/。5 次给点 buffer。
    const findPackageJson = (startDir: string): string | null => {
      let dir = startDir;
      for (let i = 0; i < 5; i++) {
        const candidate = join(dir, 'package.json');
        if (existsSync(candidate)) return candidate;
        dir = dirname(dir);
      }
      return null;
    };
    const pkgPath = findPackageJson(__dirname);
    if (!pkgPath) return;
    const pkg: { name: string; version: string; publishConfig?: { registry?: string } } =
      JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const registry: string = pkg.publishConfig?.registry || 'https://registry.npmjs.org';
    const res: Response = await fetch(`${registry}/${pkg.name}/latest`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const data = await res.json() as { version?: string };
    if (data.version && data.version !== pkg.version) {
      process.stderr.write(tCli('cli.update.new_version_available', lang, {
        old: pkg.version, new: data.version, pkg: pkg.name,
      }));
    }
  } catch { /* 静默失败,不影响正常使用 */ }
}
