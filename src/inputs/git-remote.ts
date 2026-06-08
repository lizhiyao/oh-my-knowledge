import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SourceResolveError } from './skill-loader.js';

/**
 * 远端 git 源 —— 把某个远端仓库的某个 ref 取到本地临时 bare 仓库,再交给既有 git helper
 * (classifyGitSkillRef / materializeGitSkillTree)按 repoRoot 解析、物化。install 与(将来)eval
 * 共用此一处:远端只是把 repoRoot 从「当前仓库」换成「fetch 下来的临时 bare」,下游一字不改。
 *
 * 认证依赖本机 git 凭证(SSH agent / credential helper),omk 不自管 token。失败 fail-closed,
 * 以 SourceResolveError(messageKey)抛出,由调用方本地化。
 */

// 探测式 stdio:吞 git 的 stderr,避免一次正常 install 在终端打印吓人的 fatal:。
const GIT_PROBE_STDIO: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore'];

export interface RemoteGitCheckout {
  /** 临时 bare 仓库路径,作为 git helper 的 cwd(repoRoot)。 */
  repoRoot: string;
  /** fetch 落地后 rev-parse 出的**实际 SHA**(branch/tag 会漂,记录与重取都钉 SHA)。 */
  ref: string;
  /** 删临时 bare 仓库;调用方务必 try/finally 调用。 */
  cleanup: () => void;
}

/**
 * 形态校验:接受 https(s):// / ssh:// / git:// / file:// 协议 URL、scp 形式 `user@host:path`、
 * 以及绝对本地路径(用于 file 远端 / 测试)。明显非法(空、相对裸串)直接拒,避免把无意义串喂给 git。
 */
export function isPlausibleGitUrl(url: string): boolean {
  if (!url) return false;
  if (/^(https?|ssh|git|file):\/\//i.test(url)) return true; // 协议 URL
  if (/^[\w.-]+@[\w.-]+:/.test(url)) return true;            // scp 形式 git@host:path
  if (/^\//.test(url)) return true;                          // 绝对本地路径(裸仓库 / file 远端)
  return false;
}

/**
 * clone 远端某 ref 到临时 bare 仓库,pin 实际 SHA。用 `git init --bare` + `git fetch --depth 1`
 * (省带宽,只取该 ref 的 tip 树);ref 为 branch/tag/HEAD 时通用,为裸 SHA 时取决于服务端是否
 * 允许 reachable-SHA fetch,失败会以 remote_fetch_failed 报出。
 */
export function fetchRemoteGitRef(url: string, ref: string): RemoteGitCheckout {
  if (!isPlausibleGitUrl(url)) throw new SourceResolveError('cli.install.invalid_remote_url', { url });
  const bare = mkdtempSync(join(tmpdir(), 'omk-git-remote-'));
  const cleanup = (): void => {
    try {
      rmSync(bare, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不致命
    }
  };
  try {
    execFileSync('git', ['init', '--bare', '--quiet', bare], { stdio: GIT_PROBE_STDIO });
    try {
      execFileSync(
        'git',
        ['--git-dir', bare, 'fetch', '--depth', '1', '--quiet', url, `${ref}:refs/omk/fetched`],
        { stdio: GIT_PROBE_STDIO },
      );
    } catch {
      throw new SourceResolveError('cli.install.remote_fetch_failed', { url, ref });
    }
    let sha: string;
    try {
      sha = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/omk/fetched'], {
        encoding: 'utf-8',
        stdio: GIT_PROBE_STDIO,
      }).trim();
    } catch {
      throw new SourceResolveError('cli.install.remote_ref_not_found', { url, ref });
    }
    if (!sha) throw new SourceResolveError('cli.install.remote_ref_not_found', { url, ref });
    return { repoRoot: bare, ref: sha, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
