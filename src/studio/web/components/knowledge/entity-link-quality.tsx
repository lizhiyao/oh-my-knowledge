import type { Language } from '../layout/shell';
import type { EntityLinkStudioQuality } from '../../../view-models/knowledge/entity-links';

export function EntityLinkQualityEvidence({ value, failed, lang }: { value?: EntityLinkStudioQuality; failed: boolean; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <details><summary>{t('工作区关联观测（不调用模型）', 'Workspace link observations (no model invocation)')}</summary>
    <p className="candidate-help">{t('读取整个工作区的已保存记录。机器接纳、人工决定各有分母，均不代表准确率；同名召回范围不代表全部可能关联。', 'Reads saved workspace records. Machine admission and human decisions have separate denominators; neither measures accuracy. Name-based retrieval does not cover every possible link.')}</p>
    {failed || value?.readStatus === 'unreadable' ? <p role="alert">{t('关联观测不可读，数量未知。不能据此判断为 0；请重新读取候选与历史。', 'Link observations are unreadable; counts are unknown, not zero. Reload candidates and history.')}</p>
      : !value ? <p>{t('关联观测尚未读取。', 'Link observations have not been read.')}</p>
        : <><p>{t(`持久 review：${value.reviewCount}；可比分组：${value.groups.length}。`, `Durable reviews: ${value.reviewCount}; comparison groups: ${value.groups.length}.`)}</p>
          {!value.reviewCount && <p>{t('本次成功读取没有持久关联记录。预览不创建记录。', 'This successful read contains no durable link records. Preview creates no record.')}</p>}
          {value.groups.map((group, index) => <details key={index}><summary>{group.identity.executor} / {group.identity.model} · {group.reviews.total} review</summary>
            <p>{t(`执行分母：${group.reviews.total}；已派发：${group.reviews.dispatched}；未派发：${group.reviews.notDispatched}；结果未归档：${group.reviews.outcomeUnrecorded}。`, `Invocation denominator: ${group.reviews.total}; dispatched: ${group.reviews.dispatched}; not dispatched: ${group.reviews.notDispatched}; outcome unrecorded: ${group.reviews.outcomeUnrecorded}.`)}</p>
            <p>{t(`人工终止：${group.humanTerminations.total}；尚未归档：${group.humanTerminations.outcomeUnrecorded}；迟到归档：${group.humanTerminations.lateOutcomeRecorded}；已派发但排除接纳分母：${group.admission.terminatedDispatched}。`, `Human terminations: ${group.humanTerminations.total}; outcome unrecorded: ${group.humanTerminations.outcomeUnrecorded}; late outcome recorded: ${group.humanTerminations.lateOutcomeRecorded}; dispatched but excluded from admission: ${group.admission.terminatedDispatched}.`)}</p>
            <p className="candidate-help">{t('人工终止不计为身份拒绝或模型失败；迟到归档只保留原生证据和已知用量，不重新接纳。', 'Human termination is neither an identity rejection nor a model failure. Late archives retain native evidence and known usage without reopening admission.')}</p>
            <p>{t(`机器接纳分母：${group.admission.recorded}；接纳：${group.admission.admitted}；拒绝：${group.admission.rejected}；已派发但接纳未知：${group.admission.unrecordedDispatched}。`, `Admission denominator: ${group.admission.recorded}; admitted: ${group.admission.admitted}; rejected: ${group.admission.rejected}; dispatched with unknown admission: ${group.admission.unrecordedDispatched}.`)}</p>
            <p>{t(`人工决定分母：${group.humanDecisions.decided}；接受：${group.humanDecisions.accepted}；拒绝：${group.humanDecisions.rejected}；接纳后待定：${group.humanDecisions.undecidedAdmitted}；机器拒绝后待定：${group.humanDecisions.undecidedRejected}。`, `Human decision denominator: ${group.humanDecisions.decided}; accepted: ${group.humanDecisions.accepted}; rejected: ${group.humanDecisions.rejected}; admitted undecided: ${group.humanDecisions.undecidedAdmitted}; machine-rejected undecided: ${group.humanDecisions.undecidedRejected}.`)}</p>
            <p className="candidate-help">{t('冲突按分类版本单列。legacy/v1 的 identity_unresolved 未细分，不能与 v2 的身份未决或层级不兼容直接比较；分类变化不代表准确率变化。', 'Conflicts remain separated by classification version. Legacy/v1 identity_unresolved is unclassified and cannot be compared directly with v2 identity or kind reasons; classification changes do not measure accuracy.')}</p>
            <details><summary>{t('状态、建议、拒绝原因与用量', 'States, assessments, rejection reasons, and usage')}</summary>
              <p className="candidate-help">{t('用量仅汇总已派发 review 的已知值；unknownReviewCount 单列缺失，knownTotal 为 null 表示没有已知值或溢出，不代表 0。reportingUnspecifiedReviewCount 标明汇总中未声明提供方报告状态的历史数值；这些数值不证明提供方明确报告了 0。费用未知不会补成 0。', 'Usage sums known values from dispatched reviews only. unknownReviewCount counts missing values; null knownTotal means no known values or overflow, never zero. reportingUnspecifiedReviewCount identifies included historical numbers without a producer reporting flag; they do not prove a provider explicitly reported zero. Unknown cost is not filled with zero.')}</p>
              <pre>{JSON.stringify({ states: group.reviews.byStatus, assessments: group.assessments, admissionReasons: group.admission.reasons,
                executionFailures: group.executionFailures, organization: group.organization, usage: group.usage }, null, 2)}</pre>
            </details>
            <details><summary>{t('可比身份', 'Comparison identity')}</summary><pre>{JSON.stringify(group.identity, null, 2)}</pre></details>
          </details>)}</>}
  </details>;
}
