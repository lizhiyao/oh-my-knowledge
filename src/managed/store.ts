import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import { hashString } from '../eval-core/evaluation-reporting.js';
import type {
  ArtifactKind,
  DeriveManagedStateInput,
  DerivedManagedState,
  ManagedArtifactRecord,
  ManagedArtifactSource,
  ManagedDistributionTarget,
} from '../types/index.js';

/**
 * 受管记录的 per-record 文件存储。一条记录一个 `.omk/managed/<id>.json`,镜像 report-store 的
 * 成熟模式(原子 tmp+rename):每次 install 只碰自己那个文件,independent write、不丢别人、
 * 天然可扩展。无数据库——这个规模(每项目几十条、CLI 单写者)JSON 文件足够,且保住"可读可
 * grep 可 diff"的透明价值。
 *
 * **消费方无关的核心层**:本模块不依赖 CLI、不打印、不退出,所有函数接收显式 `dir`。CLI 命令只是
 * 众多消费方之一;omk 长成平台后 server / web / SDK 复用同一模块,甚至换 DB 实现也只需镜像这组
 * load/upsert 签名。记录的构造统一走 `buildManagedArtifactRecord`,新增字段只改这一处、所有消费方继承。
 */

export function managedDir(cwd: string = process.cwd()): string {
  return join(cwd, '.omk', 'managed');
}

export function globalManagedDir(): string {
  return join(homedir(), '.oh-my-knowledge', 'managed');
}

export function recordPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/** 稳定身份 = hash(kind, name)。源路径是可变属性、不进 id。kind 取自固定枚举(无 `|`),分隔可注入。 */
export function managedRecordId(kind: ArtifactKind, name: string): string {
  return hashString(`${kind}|${name}`);
}

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
 * 给定相对源根的路径分段(空数组 = 源根本身),判断是否进可分发树。hash 的 walk 与 copy 的
 * filter 共用此一处,保证"算进 hash 的"与"分发出去的"完全一致。
 */
export function isDistributablePath(segments: string[]): boolean {
  if (segments.length === 0) return true; // 源根永远算
  const base = segments[segments.length - 1];
  if (GLOBAL_EXCLUDED_NAMES.has(base)) return false;
  if (segments.length === 1 && ROOT_ONLY_EXCLUDED_NAMES.has(base)) return false;
  return true;
}

/**
 * artifact 内容 hash —— drift baseline 与 evidence 绑定的依据。
 *   - 文件-skill:单个 .md 的字节;
 *   - 目录-skill:覆盖**整棵可分发目录树**(SKILL.md + references/ 等资产,但排除 .omk / .git /
 *     evolve 等评测迭代产物),按相对路径排序后把每个文件的`路径 + 字节长度 + 内容`喂进同一个
 *     sha256 —— 改任意资产都会令 hash 变化、drift 不漏;只补样本则 hash 不动。
 * 用 createHash 直接喂 Buffer(字节级,二进制资产也稳;分隔符是运行时字节,源码里不引入任何不可见字符)。
 * 读时(未来 list / drift 检查)用同一函数重算比对。
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

function isStringField(v: unknown): v is string {
  return typeof v === 'string';
}

// 校验到元素级:记录文件是用户可手改的(透明性是设计价值),`evidence:[null]` / 缺字段的 distribution
// 都是现实的坏手改;若只查 Array.isArray,坏元素会在 deriveManagedState / mergeManagedRecord 里
// 解引用崩溃(且在 load 的 try/catch 之外)。这里直接判脏 → load 丢弃该文件,消费方永远拿不到半成品。
function isManagedArtifactRecord(value: unknown): value is ManagedArtifactRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<ManagedArtifactRecord>;
  if (!(r.recordKind === 'managed-artifact'
    && r.schemaVersion === 1
    && isStringField(r.id)
    && isStringField(r.name)
    && isStringField(r.kind)
    && isStringField(r.contentHash)
    && r.source && typeof r.source === 'object' && isStringField((r.source as { locator?: unknown }).locator)
    && Array.isArray(r.distribution)
    && Array.isArray(r.evidence)
    && Array.isArray(r.decisions))) return false;
  const okDist = r.distribution.every((d) => d && typeof d === 'object'
    && isStringField((d as { path?: unknown }).path) && isStringField((d as { contentHash?: unknown }).contentHash));
  const okEv = r.evidence.every((e) => e && typeof e === 'object'
    && isStringField((e as { reportId?: unknown }).reportId) && isStringField((e as { contentHash?: unknown }).contentHash));
  const okDec = r.decisions.every((d) => d && typeof d === 'object'
    && isStringField((d as { decisionKind?: unknown }).decisionKind));
  return okDist && okEv && okDec;
}

export function loadManagedRecord(dir: string, id: string): ManagedArtifactRecord | null {
  const path = recordPath(dir, id);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return isManagedArtifactRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRecordsFromDir(dir: string): ManagedArtifactRecord[] {
  if (!existsSync(dir)) return [];
  const out: ManagedArtifactRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf-8')) as unknown;
      if (isManagedArtifactRecord(parsed)) out.push(parsed);
    } catch {
      // 跳过损坏文件
    }
  }
  return out;
}

/** 读全部记录。项目目录空 → 兜底全局(镜像 observe inbox 的 project→global)。 */
export function loadAllManagedRecords(dir: string = managedDir()): ManagedArtifactRecord[] {
  const local = readRecordsFromDir(dir);
  if (local.length > 0) return local;
  const global = globalManagedDir();
  if (dir !== global) {
    const fallback = readRecordsFromDir(global);
    if (fallback.length > 0) return fallback;
  }
  return local;
}

/**
 * 纯合并逻辑(无 IO):install 写的是事实,绝不动 evidence/decisions(那是 eval/promote 的地盘)。
 *   - distribution 按 path 去重(同路径以新值替换);
 *   - evidence / decisions 一律保留旧值(install 带来的恒为空)——这是设计要的"版本历史 + 附带证据",
 *     用来支撑 rollback;**但保留 ≠ 当作当前有效**:每条 evidence 携带它测的 contentHash,读时由
 *     `deriveManagedState` 只把与当前 contentHash 匹配的 evidence 算作当前证据,所以重装到新内容后
 *     旧证据仍在记录里(可回滚),却不会让新内容被读成 measurable;
 *   - installedAt 保留首次("under management since");contentHash / source 刷新到本次安装。
 */
export function mergeManagedRecord(
  prev: ManagedArtifactRecord | null,
  next: ManagedArtifactRecord,
): ManagedArtifactRecord {
  if (!prev) return next;
  // 按归一化路径去重(消除尾斜杠 / `.` / 重复分隔导致同一物理目标被记两条)。normalize 保留尾斜杠,故再去尾。
  const normKey = (p: string): string => normalize(p).replace(/[\\/]+$/, '') || p;
  const byPath = new Map<string, ManagedDistributionTarget>();
  for (const t of prev.distribution) byPath.set(normKey(t.path), t);
  for (const t of next.distribution) byPath.set(normKey(t.path), t);
  // 维护点:`...next` 取本次安装的事实,下面四个字段从 prev 保留(历史 / 首次时间)。
  // 将来若新增任何"必须从安装基线保留"的字段,务必加进这份覆盖清单,否则会被 next 静默覆盖成 undefined。
  return {
    ...next,
    installedAt: prev.installedAt,
    distribution: [...byPath.values()],
    evidence: prev.evidence,
    decisions: prev.decisions,
  };
}

/** 读旧记录 → 合并 → 原子 tmp+rename 只写该 id 的文件。返回合并后记录。 */
export function upsertManagedRecord(dir: string, record: ManagedArtifactRecord): ManagedArtifactRecord {
  const merged = mergeManagedRecord(loadManagedRecord(dir, record.id), record);
  mkdirSync(dir, { recursive: true });
  const path = recordPath(dir, record.id);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, path);
  return merged;
}

/**
 * 统一的记录构造点——所有消费方(CLI / 未来 server / SDK)经此组装,保证 schema 一致。
 * 只接收事实(身份、源、hash、分发落点);evidence/decisions 恒为空(eval/promote 的地盘)。
 */
export function buildManagedArtifactRecord(input: {
  name: string;
  kind: ArtifactKind;
  source: ManagedArtifactSource;
  contentHash: string;
  installedAt: string;
  distribution: ManagedDistributionTarget[];
  id?: string;
}): ManagedArtifactRecord {
  return {
    recordKind: 'managed-artifact',
    schemaVersion: 1,
    id: input.id ?? managedRecordId(input.kind, input.name),
    name: input.name,
    kind: input.kind,
    source: input.source,
    contentHash: input.contentHash,
    installedAt: input.installedAt,
    distribution: input.distribution,
    evidence: [],
    decisions: [],
  };
}

/** install 调用的便捷封装。 */
export function recordManagedArtifact(
  record: ManagedArtifactRecord,
  opts: { dir?: string } = {},
): ManagedArtifactRecord {
  return upsertManagedRecord(opts.dir ?? managedDir(), record);
}

/**
 * 读时推导生命周期标签。
 *   - 源缺失或 hash 漂(当前内容 ≠ 记录 contentHash)→ stale;
 *   - 否则有**当前**证据 / samples → measurable;
 *   - 否则 installed。
 * 「当前证据」= contentHash 与记录当前 contentHash 匹配的 evidence —— 旧内容的 evidence 不算数,
 * 这正是 #203「证据必须跟 artifact 一起走」的读时保证。`'discovered'` 留给无分发的记录,此函数不产生。
 */
export function deriveManagedState(input: DeriveManagedStateInput): DerivedManagedState {
  const { record, currentContentHash, hasSamplesOrDoctorPass } = input;
  const hasEvidence = record.evidence.some((e) => e.contentHash === record.contentHash);
  const drifted = currentContentHash === undefined || currentContentHash !== record.contentHash;
  if (drifted) return { label: 'stale', drifted: true, hasEvidence };
  if (hasEvidence || hasSamplesOrDoctorPass) return { label: 'measurable', drifted: false, hasEvidence };
  return { label: 'installed', drifted: false, hasEvidence };
}
