import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contentSha256 } from '../../../shared/content-hash.js';

/** 物化被拒的原因。措辞与错误码属调用方的词汇，本模块只报告发生了什么。 */
export type MaterializationRejectionReason =
  | 'content-directory-not-plain'
  | 'path-not-plain'
  | 'digest-mismatch'
  | 'concurrent-path-not-plain'
  | 'concurrent-digest-mismatch'
  | 'unsafe';

export interface MaterializationRejection {
  readonly reason: MaterializationRejectionReason;
  /** 出问题的那个路径：目录不变量时是 content 目录，其余是目标文件。 */
  readonly path: string;
  readonly cause?: unknown;
}

export type MaterializationReject = (rejection: MaterializationRejection) => never;

export type MaterializedContentExtension = '.json' | '.txt' | '.md';

/** 内部哨兵：让不变量违规穿过外层兜底，只在唯一的出口处交给调用方翻译。 */
class Rejected extends Error {
  constructor(readonly rejection: MaterializationRejection) {
    super('content materialization rejected');
  }
}

/**
 * 把字节安全地物化成 `<root>/content/<sha256><extension>`，返回落盘路径。
 *
 * 这是一条存储原语，不承载调用方的领域语义：失败只报告原因，由调用方决定措辞、
 * 错误码与错误类型。它守住四条不变量：
 *
 * 1. 目录与目标路径都必须解析成普通目录／普通文件，符号链接一律拒绝；
 * 2. 已存在的同路径内容必须摘要一致，不一致就报错，绝不覆盖；
 * 3. 写入走临时目录 ＋ `link()` 发布，读者永远看不到半截文件；
 * 4. 并发落败（`EEXIST`）时校验胜者内容摘要，一致才接受，不一致报错。
 */
export async function materializeContentAddressedBytes(input: {
  readonly root: string;
  readonly bytes: Uint8Array;
  readonly extension: MaterializedContentExtension;
  readonly reject: MaterializationReject;
}): Promise<string> {
  const { bytes, extension, reject } = input;
  const digest = contentSha256(bytes);
  const directory = join(input.root, 'content');
  const path = join(directory, `${digest.slice('sha256:'.length)}${extension}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Rejected({ reason: 'content-directory-not-plain', path: directory });
    }
    await chmod(directory, 0o700);
    try {
      const existingStat = await lstat(path);
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
        throw new Rejected({ reason: 'path-not-plain', path });
      }
      const existing = await readFile(path);
      if (contentSha256(existing) !== digest) throw new Rejected({ reason: 'digest-mismatch', path });
      await chmod(path, 0o600);
    } catch (error) {
      if (error instanceof Rejected) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        const stagingRoot = await mkdtemp(join(directory, '.materialize-'));
        try {
          const stagedPath = join(stagingRoot, 'content');
          await writeFile(stagedPath, bytes, { flag: 'wx', mode: 0o600 });
          // Publish complete bytes without replacing a concurrent winner.
          await link(stagedPath, path);
        } finally {
          await rm(stagingRoot, { recursive: true, force: true });
        }
      } catch (writeError) {
        if (writeError instanceof Rejected) throw writeError;
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        const existingStat = await lstat(path);
        if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
          throw new Rejected({ reason: 'concurrent-path-not-plain', path });
        }
        const existing = await readFile(path);
        if (contentSha256(existing) !== digest) {
          throw new Rejected({ reason: 'concurrent-digest-mismatch', path });
        }
        await chmod(path, 0o600);
      }
    }
  } catch (cause) {
    if (cause instanceof Rejected) return reject(cause.rejection);
    return reject({ reason: 'unsafe', path, cause });
  }
  return path;
}
