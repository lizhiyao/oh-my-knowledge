import { tCli, type CliLang } from './i18n.js';

/** 严格按 SemVer 2.0 precedence 判断 `a > b`(只覆盖本仓库实际使用的形态:
 *  MAJOR.MINOR.PATCH 可选 `-prerelease`)。非法字符串直接返回 false,update-check
 *  fail-safe 不提示。
 *  - release > prerelease(同 MAJOR.MINOR.PATCH)
 *  - prerelease 之间按 dot-separated identifier 比较(数字段当数字,字母段当字符串) */
export function isSemverGt(a: string, b: string): boolean {
  const parse = (v: string): { major: number; minor: number; patch: number; pre: string } | null => {
    const match = v.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' };
  };
  const av = parse(a);
  const bv = parse(b);
  if (!av || !bv) return false;
  if (av.major !== bv.major) return av.major > bv.major;
  if (av.minor !== bv.minor) return av.minor > bv.minor;
  if (av.patch !== bv.patch) return av.patch > bv.patch;
  if (av.pre === '' && bv.pre === '') return false;
  if (av.pre === '' && bv.pre !== '') return true;
  if (av.pre !== '' && bv.pre === '') return false;
  const aParts = av.pre.split('.');
  const bParts = bv.pre.split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return false;
    if (bp === undefined) return true;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const an = Number(ap);
      const bn = Number(bp);
      if (an !== bn) return an > bn;
    } else if (aNum && !bNum) {
      return false;
    } else if (!aNum && bNum) {
      return true;
    } else if (ap !== bp) {
      return ap > bp;
    }
  }
  return false;
}

/** CI / 测试环境 / 用户显式 opt-out 时跳过 update check:
 *  - 避免 CI 日志噪声(GitHub Actions / GitLab CI / CircleCI 等都设 CI=true)
 *  - vitest 启动期不打 stderr,免 snapshot / startup-budget 测试受影响
 *  - OMK_SKIP_UPDATE_CHECK=1 给用户显式 escape hatch */
function shouldSkipUpdateCheck(): boolean {
  const env = process.env;
  if (env.OMK_SKIP_UPDATE_CHECK === '1') return true;
  if (env.CI && env.CI !== '0' && env.CI !== 'false') return true;
  if (env.NODE_ENV === 'test') return true;
  return false;
}

export async function checkUpdate(lang: CliLang): Promise<void> {
  if (shouldSkipUpdateCheck()) return;
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __dirname: string = dirname(fileURLToPath(import.meta.url));
    // 从当前文件位置向上找 package.json:dev 跑 src/cli/lib/ 时 3 层到根,
    // 装到 npm 跑 dist/cli/lib/ 时 3 层到 oh-my-knowledge/。5 次给点 buffer。
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
    // 只在 registry 版本 SemVer 严格大于本地版本时提示。早先版本用 `!==`
    // 比较,本地 dev 跑出 0.32.0-rc 时会被 registry 的 0.31.0「提示降级」。
    if (data.version && isSemverGt(data.version, pkg.version)) {
      process.stderr.write(tCli('cli.update.new_version_available', lang, {
        old: pkg.version, new: data.version, pkg: pkg.name,
      }));
    }
  } catch { /* 静默失败,不影响正常使用 */ }
}
