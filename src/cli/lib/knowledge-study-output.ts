import type { ExtractionStudyInspection } from '../../knowledge/application/study-inspection.js';
import type { Lang } from '../../shared/language.js';

/** Present recomputed evidence states without treating command completion as semantic acceptance. */
export function formatKnowledgeStudy(value: ExtractionStudyInspection, lang: Lang): string {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const status = (state: 'pending' | 'blocked' | 'exploratory_reviewed' | 'accepted_within_scope') => ({
    pending: t('待复核', 'pending review'), blocked: t('已阻断', 'blocked'),
    exploratory_reviewed: t('探索复核完成，未获独立真人通过', 'exploratory review complete; no independent human acceptance'),
    accepted_within_scope: t('独立真人复核后的声明范围内通过', 'accepted within the declared scope after independent human review'),
  })[state];
  const engineering = value.analysis.assessment.engineering;
  const complete = engineering.planVerified && engineering.outputVerified
    && engineering.completeNativeSlots === engineering.plannedSlots && engineering.structurallyRejectedSlots === 0;
  const observed = (amount: number | null) => amount === null ? t('未知／未报告', 'unknown / unreported') : String(amount);
  return [t('研究证据核对 · 本次模型调用 0', 'Study evidence inspection · model calls 0'),
    `${value.plan.planId} · ${value.plan.split} · ${value.plan.changedVariable}`,
    `${t('工程核对', 'Engineering verification')}：${complete ? t('来源与原生结果完整，确定性核对通过', 'complete source/native evidence; deterministic checks passed') : t('尚有缺失、未完成或拒绝项', 'missing, incomplete or rejected evidence remains')}`,
    `${t('语义结果', 'Semantic result')}：${status(value.review.status)}`,
    `${t('复核覆盖：已复核／应复核／不确定／缺失', 'Review coverage: reviewed / expected / uncertain / missing')}：${value.review.outputReview.reviewed}/${value.review.outputReview.expected}/${value.review.outputReview.uncertain}/${value.review.missingTargets.length}`,
    `${t('参考标注准备度', 'Reference readiness')}：goldReady=${value.review.reference.goldReady}`,
    `${t('独立真人输出复核声明', 'Independent human output review attestation')}：${value.review.outputReview.independentHuman
      ? t('已提供，仍按逐项覆盖与门禁判断', 'provided; item coverage and gates still apply') : t('尚未提供', 'not provided')}`,
    ...(value.judgeReview ? [
      `${t('已保存的 AI 探索复核', 'Saved exploratory AI review')}：${status(value.judgeReview.status)} · ${t('已复核／应复核／不确定／缺失', 'reviewed / expected / uncertain / missing')} ${value.judgeReview.outputReview.reviewed}/${value.judgeReview.outputReview.expected}/${value.judgeReview.outputReview.uncertain}/${value.judgeReview.missingTargets.length} · ${t('确认错误', 'confirmed errors')} ${value.judgeReview.outputReview.confirmedErrors}`,
      t('AI 探索单独显示，不替代主输出复核或独立真人准备度。', 'AI exploration is shown separately and does not replace the main output review or independent human readiness.'),
    ] : []),
    ...value.review.variants.map(variant => {
      const slots = new Set(value.slots.filter(slot => slot.variantId === variant.variantId).map(slot => slot.slotId));
      const expected = value.review.targets.filter(target => slots.has(target.slotId)).length;
      const reviewed = value.review.decisions.filter(decision => slots.has(decision.target.slotId));
      const missing = value.review.missingTargets.filter(target => slots.has(target.slotId)).length;
      const uncertain = reviewed.filter(decision => decision.verdict === 'uncertain').length;
      return `${variant.variantId}：${status(variant.status)} · ${t('复核', 'reviewed')} ${reviewed.length}/${expected} · ${t('不确定／缺失', 'uncertain / missing')} ${uncertain}/${missing} · ${t('确认错误', 'confirmed errors')} ${variant.confirmedErrors} · ${t('必需缺口', 'required gaps')} ${variant.requiredGaps}`;
    }),
    `${t('计划／完成／失败／取消／未尝试', 'Planned / completed / failed / cancelled / unattempted')}：${value.summary.planned}/${value.summary.completed}/${value.summary.failed}/${value.summary.cancelled}/${value.summary.unattempted}`,
    `${t('OMK 已记录尝试／原生结果', 'Recorded OMK attempts / native outcomes')}：${value.summary.attempts}/${value.summary.recordedNative}`,
    `${t('执行器报告尝试数（不是供应商内部请求数）', 'Executor-reported attempts (not provider-internal requests)')}：${observed(value.summary.executorReportedAttempts)}`,
    `${t('生成费用 USD（全部尝试）', 'Generation cost USD (all attempts)')}：${observed(value.summary.totalCostUSD)}`,
    `${t('执行器耗时总和 ms', 'Summed executor duration ms')}：${observed(value.summary.totalDurationMs)}`,
    ...(value.review.blockers.length ? [`${t('阻断项', 'Blockers')}：${value.review.blockers.join(', ')}`] : []),
    ...(value.calibration ? [`${t('模型评委校准', 'Model-judge calibration')}：${value.calibration.ready ? t('声明证据覆盖完整，评委资格仍未验收', 'declared evidence coverage complete; judge acceptance remains unassessed') : t('待补足独立人工及评委证据', 'independent human or judge evidence remains incomplete')}`] : []),
    t('范围与限制：只读核对有限冻结集合，不代表总体准确率、事实已证实或发布达标。未知费用不补零；不读取或改写知识工作区。',
      'Scope and limits: read-only verification of a finite frozen set; no population accuracy, fact verification or release acceptance claim. Unknown cost is not zero; no knowledge workspace is read or changed.'),
  ].join('\n');
}
