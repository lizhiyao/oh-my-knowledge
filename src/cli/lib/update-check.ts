import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** 统一的 20h 时间窗,两处共用:同一新版本最多提示一次的节流窗口、registry 重抓的过期窗口。
 *  够长,高频命令下既不反复打网络也不反复 nag;又短于一天,用户隔天能再被提醒一次。 */
const UPDATE_WINDOW_MS = 20 * 3600_000;

/** 落盘缓存。展示只读它(热路径零网络);registry 抓取在后台写它,供下次运行用。 */
export interface UpdateCache {
  /** 上次抓到的 registry latest 版本。 */
  latestVersion: string;
  /** 上次抓取时间(ISO),用于 20h 重抓节流。 */
  lastCheckedAt: string;
  /** 上次提示过的版本,用于「同版本 20h 内不重复提示」。 */
  lastNotifiedVersion?: string;
  /** 上次提示时间(ISO)。 */
  lastNotifiedAt?: string;
}

interface LocalPkg {
  name: string;
  version: string;
  registry: string;
}

interface BoxParts {
  current: string;
  latest: string;
  upgradeCmd: string;
  silenceHint: string;
}

/** 缓存落盘走仓库既有约定 `~/.oh-my-knowledge/<...>`(见 src/eval-core/cache.ts、
 *  src/server/job-store.ts)。home 可注入,方便测试传 tmp 目录。 */
export function defaultCachePath(home: string = homedir()): string {
  return join(home, '.oh-my-knowledge', 'update-check.json');
}

/** 读缓存。缺失 / 损坏 / 非对象一律返回 null,调用方按「无缓存」处理。 */
export function readCache(path: string): UpdateCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.latestVersion !== 'string' || typeof obj.lastCheckedAt !== 'string') return null;
    return {
      latestVersion: obj.latestVersion,
      lastCheckedAt: obj.lastCheckedAt,
      lastNotifiedVersion: typeof obj.lastNotifiedVersion === 'string' ? obj.lastNotifiedVersion : undefined,
      lastNotifiedAt: typeof obj.lastNotifiedAt === 'string' ? obj.lastNotifiedAt : undefined,
    };
  } catch {
    return null;
  }
}

/** 原子写(temp + rename),避免两个 omk 进程并发写出半截 JSON。homedir 不可写时
 *  整体静默失败 — 退化为「每次后台重抓」,不崩。 */
export function writeCache(path: string, data: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  } catch {
    /* 静默:缓存是装饰性状态,写不进去不影响功能 */
  }
}

/** 是否该提示:有缓存的 latest 严格高于当前版本,且(没提示过这个版本 / 距上次提示超 20h)。
 *  纯函数,now 外部注入,便于确定性测试。 */
export function shouldNotify(
  cache: UpdateCache | null,
  currentVersion: string,
  now: Date,
  throttleMs: number = UPDATE_WINDOW_MS,
): boolean {
  if (!cache || !isSemverGt(cache.latestVersion, currentVersion)) return false;
  if (cache.lastNotifiedVersion !== cache.latestVersion) return true;
  if (!cache.lastNotifiedAt) return true;
  const last = Date.parse(cache.lastNotifiedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last > throttleMs;
}

/** 缓存是否过期(需后台重抓):无缓存 / 时间戳缺失或不可解析 / 超 ttl。 */
export function isStale(cache: UpdateCache | null, now: Date, ttlMs: number = UPDATE_WINDOW_MS): boolean {
  if (!cache?.lastCheckedAt) return true;
  const last = Date.parse(cache.lastCheckedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last > ttlMs;
}

/** 终端可视宽度:全角 / CJK codepoint 计 2,其余计 1。用 [...str] 逐 codepoint
 *  迭代以正确处理代理对。框内只用 width-1 的 ↑(U+2191)/→(U+2192),不放 emoji,
 *  避免 emoji 宽度歧义破坏右边框对齐。 */
export function visualWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首 … 彝文;含 CJK 标点(3000-303F「。、」)与统一表意(4E00-9FFF)
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII / 标点
    (cp >= 0xffe0 && cp <= 0xffe6) // 全角符号
  );
}

/** 右补空格到目标可视宽度(已超宽则原样返回)。 */
export function padToWidth(str: string, target: number): string {
  const pad = target - visualWidth(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

/** 渲染多行高亮边框(纯函数,可快照测试)。内宽取各行最大可视宽度,逐行用
 *  padToWidth 对齐后画 ┌┐└┘─│ 框,返回前后留白、以 \n 结尾的整串。 */
export function renderUpdateBox(parts: BoxParts, lang: CliLang): string {
  const lines = [
    tCli('cli.update.box_title', lang),
    tCli('cli.update.box_version_line', lang, { old: parts.current, new: parts.latest }),
    tCli('cli.update.box_upgrade_line', lang, { cmd: parts.upgradeCmd }),
    tCli('cli.update.box_silence_line', lang, { env: parts.silenceHint }),
  ];
  const inner = Math.max(...lines.map(visualWidth));
  const top = `┌${'─'.repeat(inner + 2)}┐`;
  const bottom = `└${'─'.repeat(inner + 2)}┘`;
  const body = lines.map((l) => `│ ${padToWidth(l, inner)} │`);
  return `\n${[top, ...body, bottom].join('\n')}\n\n`;
}

/** 选染提示文案:TTY 下多行高亮框,管道 / 非 TTY 退回单行(不污染输出)。纯函数,
 *  isTty 注入便于测试两条分支。 */
export function renderNotice(parts: BoxParts, pkgName: string, lang: CliLang, isTty: boolean): string {
  if (isTty) return renderUpdateBox(parts, lang);
  return tCli('cli.update.new_version_available', lang, {
    old: parts.current,
    new: parts.latest,
    pkg: pkgName,
  });
}

/** 从当前文件位置向上找 package.json:dev 跑 src/cli/lib/ 时 3 层到根,
 *  装到 npm 跑 dist/cli/lib/ 时 3 层到 oh-my-knowledge/。5 次给点 buffer。 */
function readLocalPkg(): LocalPkg | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg: { name?: string; version?: string; publishConfig?: { registry?: string } } = JSON.parse(
          readFileSync(candidate, 'utf-8'),
        );
        if (!pkg.name || !pkg.version) return null;
        return {
          name: pkg.name,
          version: pkg.version,
          // 优先用用户实际安装源(npm 从 .npmrc 注入 npm_config_registry),再退 publish 目标,最后兜底官方源
          registry: process.env.npm_config_registry || pkg.publishConfig?.registry || 'https://registry.npmjs.org',
        };
      }
      dir = dirname(dir);
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** 后台刷新:spawn 一个 detached + unref 的子进程去抓 registry latest 写回缓存,跟父进程
 *  生命周期解耦 —— native fetch 的网络 handle 会让进程存活到请求完成 / 3s abort,留在父进程里
 *  会拖住快命令的退出;丢给独立子进程后,父进程发完 spawn 立即返回、可正常退出,热路径零网络。
 *  worker 只在编译产物(dist/cli/lib/)里有 `.js`;dev 直接跑源码时不存在,existsSync 兜底跳过。 */
function fetchAndStore(path: string, pkg: LocalPkg): void {
  try {
    const worker = join(dirname(fileURLToPath(import.meta.url)), 'update-fetch-worker.js');
    if (!existsSync(worker)) return;
    spawnDetached(worker, [path, pkg.registry, pkg.name]);
  } catch {
    /* 静默:spawn 同步抛错(罕见)不影响正常使用 */
  }
}

/** spawn 一个 detached + unref 的子进程跑 worker。子进程启动失败(ENOENT / EACCES /
 *  EAGAIN)是异步 `error` 事件 —— 不挂 listener 的话 Node 会当 uncaught exception 抛出、
 *  反过来拖垮主命令,所以必须挂个空 handler 吞掉,维持升级检查全程 fail-silent。 */
export function spawnDetached(scriptPath: string, args: string[]): void {
  const child = spawn(process.execPath, [scriptPath, ...args], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    /* 静默:子进程起不来不影响主命令 */
  });
  child.unref();
}

/** 升级提示:展示与抓取解耦。本次运行只读缓存即时决定是否提示(热路径零网络);
 *  缓存过期时后台抓一次写回,供下次用。首次运行(无缓存)不提示。全程 fail-silent,
 *  由 index.ts 在非短路径下 fire-and-forget 调用。 */
export async function checkUpdate(lang: CliLang): Promise<void> {
  if (shouldSkipUpdateCheck()) return;
  try {
    const pkg = readLocalPkg();
    if (!pkg) return;
    const path = defaultCachePath();
    const cache = readCache(path);
    const now = new Date();

    // 展示:仅凭缓存,无网络
    if (shouldNotify(cache, pkg.version, now) && cache) {
      const parts: BoxParts = {
        current: pkg.version,
        latest: cache.latestVersion,
        upgradeCmd: 'npm i -g oh-my-knowledge@latest',
        silenceHint: 'OMK_SKIP_UPDATE_CHECK=1',
      };
      process.stderr.write(renderNotice(parts, pkg.name, lang, process.stderr.isTTY === true));
      writeCache(path, { ...cache, lastNotifiedVersion: cache.latestVersion, lastNotifiedAt: now.toISOString() });
    }

    // 抓取:后台,供下次运行
    if (isStale(cache, now)) {
      fetchAndStore(path, pkg);
    }
  } catch {
    /* 静默失败,不影响正常使用 */
  }
}
