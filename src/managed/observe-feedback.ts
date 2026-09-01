/**
 * observe → managed 反哺(#235)。一次 `omk observe` 跑完,把每个 skill 的生产健康(盲区率 / 严重度加权 /
 * 统计功效 / 盲区类型计数)落成一条 `ManagedObservation` 追加进**已纳管**的同名 skill 记录,供读时派生
 * production-gap marker(`deriveProductionGap`)与「建议补样本」提示。写入仿 `evidence.ts` 的 `recordEvalEvidence`。
 *
 * 三条与 eval 写证据对齐的取舍:
 *   - **触发**:observe 完成自动写,但只写**已存在**的受管记录(install 是显式 opt-in,未纳管 skill 永不被
 *     凭空建记录,零副作用惊吓);CLI 另给 `--no-feedback` 关。
 *   - **去重**:append-only + 按 `reportId` 去重(observe 无 contentHash,一份报告对一条观测;新窗口是新报告
 *     → 新条目 = 时间序)。
 *   - **匹配**:按 skill **名** + `kind==='skill'` 绑 —— observe 报告只带名、无 contentHash。observe 的 skillName
 *     是 trace 调用名(已 `normalizeSkillName` 去插件前缀),`record.name` 是 install 名,约定相等;skill 的
 *     frontmatter `name:` ≠ 目录名时静默不匹配(fail-safe,见 spec §7 已知局限)。
 *
 * 版本无关:观测的是线上**正在跑那一版**(无 skill contentHash),故产读时 marker、**绝不翻 stale**
 * (§6.1 只有内容漂移翻 stale;observe 是信号源不是受控 eval)。
 */
import type { ManagedObservation } from '../types/index.js';
import {
  loadAllManagedRecords,
  appendManagedObservation,
  managedDir,
  resolveManagedDir,
  isProductionGapObservation,
} from './store.js';

/** 结构化最小入参：observe CLI 侧从 `SkillHealthReport` 抽出
 *  这几样传入,`managed/` 不 import `observability/`(避免跨支柱反向依赖)。`healthBand` 由 CLI 用 observability
 *  自己的 `healthBandOf` 算好传入 —— 阈值单一来源,managed 不复制阈值、不伪造 observe 不出的 per-skill band。 */
export interface ObservedSkillHealthView {
  skillName: string;
  segmentCount: number;
  gapRate: number;
  weightedGapRate: number;
  confidence: 'high' | 'low' | 'underpowered';
  healthBand: 'green' | 'yellow' | 'red';
  gapByType: { failed_search: number; explicit_marker: number; hedging: number; repeated_failure: number };
}

export interface ObserveReportView {
  /** observe-health 报告 id —— 观测去重主键。 */
  reportId: string;
  /** 被观测**流量窗口的结束时刻**(report.meta.timeRange.to,CLI 侧 buildObserveReportView 取,空则退
   *  generatedAt)——供 deriveProductionGap 的 latest-wins,不是报告生成的「此刻」(generatedAt 恒约等于
   *  now,拿它比会让所有观测一样新)。无版本闸门:观测是版本无关的生产信号(见 ManagedObservation.observedAt)。 */
  observedAt: string;
  skills: ObservedSkillHealthView[];
}

export interface RecordedObservation {
  recordId: string;
  name: string;
  healthBand: 'green' | 'yellow' | 'red';
  confidence: 'high' | 'low' | 'underpowered';
  /** 该观测是否构成确诊生产盲区(red 且够力)—— CLI 据此选「盲区警示」还是「已记录」文案。 */
  isProductionGap: boolean;
  gapByType: ManagedObservation['gapByType'];
}

/**
 * 驱动:对每个能按 name(限 kind==='skill')匹配到的**已纳管**记录追加一条生产健康观测。返回实际写入清单
 * (供 CLI 提示)。无任何记录匹配 → 返回空(常见的非管理用户场景,静默无副作用)。
 */
export function recordObserveHealth(
  report: ObserveReportView,
  opts: { dir?: string } = {},
): RecordedObservation[] {
  const out: RecordedObservation[] = [];
  if (report.skills.length === 0) return out;
  // 写回读方实际取记录的同一目录(project→global 同口径)。
  const dir = resolveManagedDir(opts.dir ?? managedDir());
  const records = loadAllManagedRecords(dir);
  if (records.length === 0) return out;
  // 按 name 索引,仅 kind==='skill':同名跨 kind 的 prompt/agent 记录不接 observe 信号(observe 测的是 skill)。
  // id = hash(kind,name) 保证每个 (skill,name) 至多一条记录,故 name→record 唯一,无需唯一性闸门。
  const byName = new Map<string, { id: string; name: string }>();
  for (const r of records) if (r.kind === 'skill') byName.set(r.name, { id: r.id, name: r.name });
  for (const s of report.skills) {
    const rec = byName.get(s.skillName);
    if (!rec) continue;
    const observation: ManagedObservation = {
      observationKind: 'production-health',
      reportId: report.reportId,
      observedAt: report.observedAt,
      gapRate: s.gapRate,
      weightedGapRate: s.weightedGapRate,
      confidence: s.confidence,
      healthBand: s.healthBand,
      segmentCount: s.segmentCount,
      gapByType: s.gapByType,
    };
    const merged = appendManagedObservation(dir, rec.id, observation);
    if (!merged) continue;
    out.push({
      recordId: rec.id,
      name: rec.name,
      healthBand: s.healthBand,
      confidence: s.confidence,
      isProductionGap: isProductionGapObservation(observation),
      gapByType: s.gapByType,
    });
  }
  return out;
}
