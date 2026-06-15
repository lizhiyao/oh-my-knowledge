import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { hashString } from '../eval-core/evaluation-reporting.js';
import { OMK_HOME } from '../eval-core/default-dirs.js';
import type {
  ArtifactKind,
  DeriveManagedStateInput,
  DerivedManagedState,
  ManagedArtifactRecord,
  ManagedArtifactSource,
  ManagedDecision,
  ManagedDistributionTarget,
  ManagedEvidenceRef,
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
  return join(OMK_HOME, 'managed');
}

export function recordPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/** 稳定身份 = hash(kind, name)。源路径是可变属性、不进 id。kind 取自固定枚举(无 `|`),分隔可注入。 */
export function managedRecordId(kind: ArtifactKind, name: string): string {
  return hashString(`${kind}|${name}`);
}

// 内容指纹工具已下沉到 inputs 层(install 与 eval 共用同一处,保证指纹同空间);此处 re-export
// 保持 managed 公共入口不破(install 仍从 managed 取 hashArtifactSource / isDistributablePath)。
export { hashArtifactSource, isDistributablePath, distributableCopyFilter } from '../inputs/content-hash.js';

function isStringField(v: unknown): v is string {
  return typeof v === 'string';
}

/** 仅当字段缺省或是 string 才放行(可选 string 字段的脏值守卫,如 source.url / evidence.verdict)。 */
function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string';
}

// 受管记录可安装的 kind(managed 记录绝不是 baseline)。
const MANAGED_KINDS = new Set(['skill', 'prompt', 'agent', 'workflow']);

// 校验到**运行时实际收窄**的边界,不止「字段是 string」:记录文件是用户可手改、且可能随仓库分发(被
// loadAllManagedRecords 无 opt-in 读到)的不可信输入。若只查 string,畸形记录(如 source.url 是对象、
// sourceKind 是任意串)会绕过 validator,在下游(omk list 的 sourceLabel ?? → dispWidth(对象) 等)
// 抛 TypeError 让命令崩溃。这里把 source / evidence 收窄到 list 等消费方实际解引用的类型,判脏即丢弃该文件。
function isManagedArtifactRecord(value: unknown): value is ManagedArtifactRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<ManagedArtifactRecord>;
  if (!(r.recordKind === 'managed-artifact'
    && r.schemaVersion === 2
    && isStringField(r.id)
    && isStringField(r.name)
    && isStringField(r.kind) && MANAGED_KINDS.has(r.kind)
    && isStringField(r.contentHash)
    && r.source && typeof r.source === 'object'
    && Array.isArray(r.distribution)
    && Array.isArray(r.evidence)
    && Array.isArray(r.decisions))) return false;
  const src = r.source as unknown as Record<string, unknown>;
  if (!(isStringField(src.locator)
    && (src.sourceKind === 'file' || src.sourceKind === 'git')
    && typeof src.isDirectorySkill === 'boolean'
    && isOptionalString(src.url)
    && isOptionalString(src.ref))) return false;
  // url / ref 是 git-only 字段。file 源带 url 时,list 的 sourceLabel 会显示假 url、掩盖真实被 probe /
  // 读取的 locator(畸形但可通过上面 string 校验)→ 「读了什么」与「显示什么」不一致。判脏丢弃。
  if (src.sourceKind === 'file' && (src.url !== undefined || src.ref !== undefined)) return false;
  const okDist = r.distribution.every((d) => d && typeof d === 'object'
    && isStringField((d as { path?: unknown }).path) && isStringField((d as { contentHash?: unknown }).contentHash));
  const okEv = r.evidence.every((e) => {
    if (!e || typeof e !== 'object') return false;
    const ev = e as unknown as Record<string, unknown>;
    if (!(isStringField(ev.reportId) && isStringField(ev.contentHash) && isStringField(ev.recordedAt))) return false;
    if (!isOptionalString(ev.verdict)) return false;
    // comparability 若存在:必须是带 string cliVersion 的对象(list / promote 会读它)。可选 marker
    // judgePromptHash / debiasMode 同样收窄到声明类型 —— 否则任意类型脏值会穿过 validator 原样进 `omk list
    // --json`(及未来 promote gate)消费方。
    if (ev.comparability !== undefined) {
      const c = ev.comparability as Record<string, unknown>;
      if (!c || typeof c !== 'object' || !isStringField(c.cliVersion)) return false;
      if (!isOptionalString(c.judgePromptHash)) return false;
      if (c.debiasMode !== undefined
        && !(Array.isArray(c.debiasMode) && c.debiasMode.every((m) => m === 'length' || m === 'position'))) return false;
    }
    return true;
  });
  const okDec = r.decisions.every((d) => {
    if (!d || typeof d !== 'object') return false;
    const dec = d as unknown as Record<string, unknown>;
    if (!isStringField(dec.decisionKind)) return false;
    // promote/reject/rollback 的证据指针(promote 写)同样收窄:任意类型脏值不得穿过 validator 进
    // deriveManagedState / promote 消费方。actor / decidedAt / reason 是 install 后才追加的可选展示字段,
    // 旧记录(install 时 decisions 恒空)无,按 optional 读。
    if (!isOptionalString(dec.actor) || !isOptionalString(dec.decidedAt) || !isOptionalString(dec.reason)) return false;
    if (!isOptionalString(dec.contentHash) || !isOptionalString(dec.reportId)) return false;
    if (dec.override !== undefined) {
      const o = dec.override as Record<string, unknown>;
      if (!o || typeof o !== 'object' || !isStringField(o.verdict)) return false;
      if (o.overriddenBlocks !== undefined
        && !(Array.isArray(o.overriddenBlocks) && o.overriddenBlocks.every((b) => typeof b === 'string'))) return false;
    }
    return true;
  });
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
 * 哪个 managed 目录是权威(有记录的那个):项目目录非空取项目,否则全局非空取全局,都空回项目。
 * 与 `loadAllManagedRecords` 的 project→global 回退**同口径** —— 写方(append evidence)据此写回
 * 读方实际取记录的同一目录,避免"读全局、写项目"把证据落到空目录。
 */
export function resolveManagedDir(dir: string = managedDir()): string {
  if (readRecordsFromDir(dir).length > 0) return dir;
  const global = globalManagedDir();
  if (dir !== global && readRecordsFromDir(global).length > 0) return global;
  return dir;
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
  // 注意语义边界:distribution 是**多源容忍**的(按归一化 path 累积去重),而 source / contentHash 是
  // **末次写入(单源)**。同一 (kind,name) 先 file 后 git 重装会得到一条 source=git 的记录,但 distribution
  // 仍含 file 时代的落点 —— 那些落点会按 git 的 contentHash 被判 drift。这是"换源即重基线"的有意取舍。
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
 * 追加一条评测证据(append-only)。与 install 的 upsert 路径相反——`mergeManagedRecord` 刻意**保留旧
 * evidence、丢弃 next.evidence**(install 只写事实),所以证据写入不能走 upsert,必须独立 load→push→
 * 原子重写。按 `(reportId, contentHash)` 去重:重跑同一份 eval 不堆重复条目(reportId 含运行身份,
 * 同内容重测会是新 reportId → 新条目,正是要的版本史)。记录不存在(未 install / 名字不匹配)返回
 * null —— 这是"管理是 install 显式 opt-in"的体现:eval 绝不为未纳管的 skill 凭空建记录。
 */
export function appendManagedEvidence(
  dir: string,
  recordId: string,
  evidence: ManagedEvidenceRef,
): ManagedArtifactRecord | null {
  const prev = loadManagedRecord(dir, recordId);
  if (!prev) return null;
  const dup = prev.evidence.some(
    (e) => e.reportId === evidence.reportId && e.contentHash === evidence.contentHash,
  );
  const merged: ManagedArtifactRecord = dup
    ? prev
    : { ...prev, evidence: [...prev.evidence, evidence] };
  if (!dup) {
    mkdirSync(dir, { recursive: true });
    const path = recordPath(dir, recordId);
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2));
    renameSync(tmp, path);
  }
  return merged;
}

/**
 * 把受管记录的 drift 基线(contentHash)重锚到新源内容哈,保留 evidence / decisions / source /
 * distribution 全不动。用于 `omk evolve` 把胜出版本写回 source 后,让记录跟上实际内容——否则记录的
 * contentHash 仍指旧基线,list 会把被 evolve 改过的受管 skill 永久显示成 stale。
 *
 * 只动 contentHash:旧 hash 锚定的旧 evidence / promote 决定自动变「非当前」(其 contentHash ≠ 新基线)=
 * 历史,不再冒充当前状态;新内容的证据 / 决定由调用方另行 append。已经是该 hash → no-op 不重写。记录不存在
 * 返回 null(同 evidence / decision:管理是 install 显式 opt-in)。
 */
export function rebaselineManagedContentHash(
  dir: string,
  recordId: string,
  newHash: string,
): ManagedArtifactRecord | null {
  const prev = loadManagedRecord(dir, recordId);
  if (!prev) return null;
  if (prev.contentHash === newHash) return prev;
  const merged: ManagedArtifactRecord = { ...prev, contentHash: newHash };
  mkdirSync(dir, { recursive: true });
  const path = recordPath(dir, recordId);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, path);
  return merged;
}

/**
 * 当前内容(contentHash === record.contentHash)是否处于 promoted 态。决定是 append-only 事件流,
 * promote 与 rollback 互为反操作,故不能看「是否存在过 promote」,而要看**当前内容最近一条** promote/rollback
 * 决定是不是 promote —— rollback 之后再 promote 仍能恢复 promoted,反之亦然。换了内容(contentHash 变)后
 * 旧内容的决定一概不算数。
 *
 * 「最近」按 decidedAt 真实时刻取,与 `latestCurrentEvidence` 同口径:omk 自写恒 UTC `Z`、字典序即时间序;
 * 但记录可手改 / 随仓库分发,异偏移 ISO 串字典序会乱 → 两端可解析才用解析时刻,否则退字典序;并列取后出现的
 * (数组追加序 = 事件序)。
 */
export function isCurrentlyPromoted(record: ManagedArtifactRecord): boolean {
  return latestPromoteRollbackForCurrent(record)?.decisionKind === 'promote';
}

/** 当前内容(contentHash === record.contentHash)最近一条 promote/rollback 决定;无则 undefined。latest-wins
 *  口径见上(decidedAt 真实时刻、不可解析退字典序、并列取后出现的)。isCurrentlyPromoted 与
 *  currentPromoteOverride 共用,避免两处各写一遍 latest-wins 走样。 */
function latestPromoteRollbackForCurrent(record: ManagedArtifactRecord): ManagedDecision | undefined {
  const ms = (s: string): number | null => { const n = Date.parse(s); return Number.isNaN(n) ? null : n; };
  let latest: ManagedDecision | undefined;
  for (const d of record.decisions) {
    if (d.contentHash !== record.contentHash) continue;
    if (d.decisionKind !== 'promote' && d.decisionKind !== 'rollback') continue;
    if (latest === undefined) { latest = d; continue; }
    const tcur = ms(d.decidedAt); const tlat = ms(latest.decidedAt);
    const newer = tcur !== null && tlat !== null ? tcur >= tlat : d.decidedAt >= latest.decidedAt;
    if (newer) latest = d;
  }
  return latest;
}

/**
 * 当前 promoted 版本是否经 override(--force)采用 —— 返回该 override(verdict + 被绕过的门),否则 undefined。
 * 仅当前内容最近一条决定是 promote 且带 override 才有值;rollback 之后(已撤销接受)返回 undefined。供 list /
 * Studio **读时审计**:从总览一眼看出哪些当前采用是越门来的。override 的**写**仍只在 CLI(`promote --force`),
 * Studio 不执行——见 evidence-gated-management.md §9(#238)。
 */
export function currentPromoteOverride(record: ManagedArtifactRecord): ManagedDecision['override'] {
  const d = latestPromoteRollbackForCurrent(record);
  return d?.decisionKind === 'promote' ? d.override : undefined;
}

/**
 * 追加一条人工管理决定(append-only,promote/reject/rollback 走此路)。与 evidence 同样**不能走 upsert**
 * (`mergeManagedRecord` 刻意保留旧 decisions、丢弃 next.decisions),必须独立 load→push→原子重写。
 *
 * 幂等:对**当前内容**的 promote/rollback,看是否会改变当前 promoted 态——已 promoted 再 promote、未 promoted
 * 再 rollback 都不追加、原样返回(由 CLI 提示「已 promoted」/「未 promoted」)。这让重复 `omk promote` /
 * `omk rollback` 不堆冗余事件,但 promote↔rollback 的真实切换、以及换了内容(contentHash 变)后的新决定仍会
 * 追加——正是要的版本史。其它 decisionKind(如 reject)仍按「同 kind + 同 contentHash 即 dedup」。记录不存在
 * (未 install)返回 null,与 evidence 同口径(管理是 install 显式 opt-in,绝不为未纳管 skill 凭空建记录)。
 */
export function appendManagedDecision(
  dir: string,
  recordId: string,
  decision: ManagedDecision,
): ManagedArtifactRecord | null {
  const prev = loadManagedRecord(dir, recordId);
  if (!prev) return null;
  const isPromotion = decision.decisionKind === 'promote' || decision.decisionKind === 'rollback';
  const onCurrent = decision.contentHash !== undefined && decision.contentHash === prev.contentHash;
  const dup = isPromotion && onCurrent
    // promote/rollback 当前内容:不改变 promoted 态 → no-op(promote 当已 promoted、rollback 当未 promoted)。
    ? (decision.decisionKind === 'promote') === isCurrentlyPromoted(prev)
    : decision.contentHash !== undefined
      && prev.decisions.some((d) => d.decisionKind === decision.decisionKind && d.contentHash === decision.contentHash);
  const merged: ManagedArtifactRecord = dup
    ? prev
    : { ...prev, decisions: [...prev.decisions, decision] };
  if (!dup) {
    mkdirSync(dir, { recursive: true });
    const path = recordPath(dir, recordId);
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2));
    renameSync(tmp, path);
  }
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
    schemaVersion: 2,
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
 *   - 否则当前内容已有 promote 决定 → promoted;
 *   - 否则有**当前**证据 / samples → measurable;
 *   - 否则 installed。
 * 「当前证据 / 当前决定」= contentHash 与记录当前 contentHash 匹配的 evidence / decision —— 旧内容的不算数,
 * 这正是 #203「证据必须跟 artifact 一起走」的读时保证。`'discovered'` 留给无分发的记录,此函数不产生。
 */
export function deriveManagedState(input: DeriveManagedStateInput): DerivedManagedState {
  const { record, currentContentHash, hasSamplesOrDoctorPass } = input;
  const hasEvidence = record.evidence.some((e) => e.contentHash === record.contentHash);
  const drifted = currentContentHash === undefined || currentContentHash !== record.contentHash;
  if (drifted) return { label: 'stale', drifted: true, hasEvidence };
  // 当前内容(contentHash 匹配)最近一条 promote/rollback 决定是 promote → 已人工接受当前版本,排在 measurable
  // 之上。rollback 之后落回 measurable/installed;换了内容(contentHash 变)后旧决定不冒充当前。
  if (isCurrentlyPromoted(record)) return { label: 'promoted', drifted: false, hasEvidence };
  if (hasEvidence || hasSamplesOrDoctorPass) return { label: 'measurable', drifted: false, hasEvidence };
  return { label: 'installed', drifted: false, hasEvidence };
}
