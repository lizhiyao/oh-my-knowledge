import type { Report } from '../types/index.js';
import { executorVendor, type ExecutorVendor } from '../executors/shared.js';

/**
 * 评委独立性分析(单一来源,verdict caveat 与 analysis 诊断共用)。
 *
 * LLM 评委有自我偏好偏置:偏爱与自己同模型家族产出的输出。omk 默认评委(claude:haiku)与默认
 * 执行器(claude:*)同属一家,敞口默认就开着。本 helper 只算客观事实(评委/输出各属哪家、有没有
 * 跨厂商评委、是不是单厂商 ensemble、有没有挂 gold 校准),严重度与文案交给消费方(report-diagnostics
 * / verdict)决定。
 *
 * 缓解阶梯(行业共识):换跨厂商评委 > 跨厂商陪审团 > 人工金标校准 > 警告。omk 无法强制换 key,
 * 故只检测 + 警告并指向 `--judge-models <跨厂商>` 和 `omk eval gold compare`。
 */
export interface JudgeIndependence {
  /** 各评委的厂商家族(与 judgeModels 同序)。 */
  judgeVendors: ExecutorVendor[];
  /** 被测输出涉及的厂商家族(去重)。 */
  outputVendors: ExecutorVendor[];
  /** 至少有一个评委的厂商不在被测输出厂商集合里 —— 存在独立(跨厂商)评委。 */
  crossVendorJudgePresent: boolean;
  /** 有评委、厂商全可归类、且无任何跨厂商评委 —— 自我偏好敞口(J1)。 */
  sameVendorJudge: boolean;
  /** ≥ 2 评委且全部同一个(已归类)厂商 —— ensemble 一致性不反驳共有偏置(J2)。 */
  singleVendorEnsemble: boolean;
  /** 本次 run 挂了人工 gold 校准(report.meta.humanAgreement 存在)→ 敞口有背板。 */
  goldCalibrated: boolean;
}

export function analyzeJudgeIndependence(report: Report): JudgeIndependence {
  const judges = report.meta?.judgeModels ?? [];
  const judgeVendors = judges.map((j) => executorVendor(j.executor));

  const runtimes = report.meta?.executorRuntimes;
  const outputExecutors = runtimes && Object.keys(runtimes).length > 0
    ? Object.values(runtimes).map((r) => r.executor).filter((e): e is string => !!e)
    : (report.meta?.executor ? [report.meta.executor] : []);
  const outputVendors = [...new Set(outputExecutors.map(executorVendor))];

  const goldCalibrated = report.meta?.humanAgreement != null;

  const base = { judgeVendors, outputVendors, goldCalibrated };

  // noJudge(无评委)、或任一厂商无法归类(自定义 script)、或拿不到被测厂商 → 不评估,不误报。
  const anyUnknown = judgeVendors.includes('unknown') || outputVendors.includes('unknown');
  if (judges.length === 0 || anyUnknown || outputVendors.length === 0) {
    return { ...base, crossVendorJudgePresent: false, sameVendorJudge: false, singleVendorEnsemble: false };
  }

  const outSet = new Set(outputVendors);
  const crossVendorJudgePresent = judgeVendors.some((v) => !outSet.has(v));
  const singleVendorEnsemble = judges.length >= 2 && new Set(judgeVendors).size === 1;

  return {
    ...base,
    crossVendorJudgePresent,
    sameVendorJudge: !crossVendorJudgePresent,
    singleVendorEnsemble,
  };
}
