import { tCli, type CliLang } from './i18n.js';

export async function checkUpdate(lang: CliLang): Promise<void> {
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __dirname: string = dirname(fileURLToPath(import.meta.url));
    const pkg: { name: string; version: string; publishConfig?: { registry?: string } } =
      JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
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
