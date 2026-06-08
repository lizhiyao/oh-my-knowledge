import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * artifact「可分发树」与内容指纹 —— inputs 层的纯内容哈希工具。install(受管记录)与 eval
 * (report 的 artifactHashes)共用同一处,保证「同一个 skill,装出来与测出来的指纹落在同一空间」,
 * 是证据随 artifact 走(evidence.contentHash === record.contentHash)的承重基础。
 *
 * 放在 inputs 层而非 managed:这两个函数语义上属内容哈希、无 managed 专属依赖;skill-loader、
 * source-resolver、managed/store 都在它之上消费,inputs 是更低层,不成环。
 */

/**
 * 不进 artifact「可分发树」的条目 —— omk 的评测 / 迭代 / VCS / 系统产物,既不该被拷进 agent
 * skill 目录,也不该计入 artifact contentHash。区分两类语义,避免误伤合法嵌套资产:
 *   - **任意层级排除**:隐藏元数据 / VCS / 系统 / 依赖目录,任何深度出现都是噪声
 *     (`.omk` = samples / managed / observations;`.git`;`node_modules`;OS 垃圾);
 *   - **仅源根第一层排除**:omk 保留的工作目录,只在 skill 根有保留语义,嵌套同名是用户合法资产
 *     (`evolve` 是 `<skillDir>/evolve/` 候选快照;但 `references/evolve/guide.md` 应正常分发并计入 hash)。
 * spec 里 artifact content hash 与 sample-set hash 是分开的证据轴,故只补样本(.omk)不该改 hash。
 */
const GLOBAL_EXCLUDED_NAMES = new Set<string>(['.omk', '.git', 'node_modules', '.DS_Store', 'Thumbs.db']);
const ROOT_ONLY_EXCLUDED_NAMES = new Set<string>(['evolve']);

/**
 * 给定相对源根的路径分段(空数组 = 源根本身),判断是否进可分发树。hash 的 walk、copy 的 filter、
 * git 物化共用此一处,保证三者完全一致。
 *
 * 关键:检查**每一段**而非只看叶子。本地 walk / cpSync 是逐层下降、命中目录即剪枝,只看叶子也够;
 * 但 git ls-tree 给的是**扁平路径**(如 `.omk/samples.json`),只看叶子 `samples.json` 会让 `.omk`
 * 内容漏过。故:任一段命中全局排除即排除;首段命中 root-only(evolve)即排除(嵌套同名是合法资产)。
 */
export function isDistributablePath(segments: string[]): boolean {
  if (segments.length === 0) return true; // 源根永远算
  for (const seg of segments) {
    if (GLOBAL_EXCLUDED_NAMES.has(seg)) return false;
  }
  if (ROOT_ONLY_EXCLUDED_NAMES.has(segments[0])) return false;
  return true;
}

/**
 * artifact 内容 hash —— drift baseline 与 evidence 绑定的依据。
 *   - 文件-skill:单个 .md 的字节;
 *   - 目录-skill:覆盖**整棵可分发目录树**(SKILL.md + references/ 等资产,但排除 .omk / .git /
 *     evolve 等评测迭代产物),按相对路径排序后把每个文件的`路径 + 字节长度 + 内容`喂进同一个
 *     sha256 —— 改任意资产都会令 hash 变化、drift 不漏;只补样本则 hash 不动。
 * 用 createHash 直接喂 Buffer(字节级,二进制资产也稳;分隔符是运行时字节,源码里不引入任何不可见字符)。
 * 读时(list / drift 检查 / eval 报告)用同一函数重算比对。
 */
export function hashArtifactSource(source: string, isDirectorySkill: boolean): string {
  if (!isDirectorySkill) {
    return createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 12);
  }
  const rels: string[] = [];
  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const segs = [...segments, entry.name];
      if (!isDistributablePath(segs)) continue;
      // 软链既非 isFile 也非 isDirectory,天然跳过 —— 与 copyArtifactToTarget 的 filter 一致
      // (hash 覆盖的 == 分发出去的),避免软链目标改变却不触发 drift,也回避软链环。
      if (entry.isDirectory()) walk(join(dir, entry.name), segs);
      else if (entry.isFile()) rels.push(segs.join('/'));
    }
  };
  walk(source, []);
  rels.sort();
  const h = createHash('sha256');
  const sep = Buffer.from([0]);
  for (const rel of rels) {
    const content = readFileSync(join(source, rel));
    // 路径与内容都做长度前缀,彻底排除"不同树拼出同一串"的歧义(文件名虽不含 NUL,核心层仍按可注入防)。
    h.update(String(Buffer.byteLength(rel)));
    h.update(sep);
    h.update(rel);
    h.update(sep);
    h.update(String(content.length));
    h.update(sep);
    h.update(content);
    h.update(sep);
  }
  return h.digest('hex').slice(0, 12);
}
