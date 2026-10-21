'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Drawer, Skeleton, Space } from 'antd';
import type { Language } from '../layout/shell';
import type { KnowledgeStudyInspection } from '../../../view-models/knowledge/knowledge-study';
import { EXTRACTION_STUDY_INSPECTION_MAX_BYTES } from '../../../../knowledge/extraction/study-capacity';
import { requestKnowledge } from './request';

type FileKey = 'evidence' | 'authorReceipt' | 'referenceReceipt' | 'outputReceipt' | 'judgeReceipt';
type StudyFiles = Partial<Record<FileKey, File>>;
type Target = KnowledgeStudyInspection['review']['targets'][number];
const fileKeys: FileKey[] = ['evidence', 'authorReceipt', 'referenceReceipt', 'outputReceipt', 'judgeReceipt'];

/** This independent session never inherits a workspace, write baseline or portable editing action. */
export function KnowledgeStudyInspectionDrawer({ lang, onClose }: { lang: Language; onClose(): void }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [files, setFiles] = useState<StudyFiles>({}), [result, setResult] = useState<KnowledgeStudyInspection | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [filesOpen, setFilesOpen] = useState(true);
  const active = useRef<AbortController | null>(null), version = useRef(0), form = useRef<HTMLFormElement | null>(null);
  const fileId = useId();
  const totalBytes = fileKeys.reduce((sum, key) => sum + (files[key]?.size ?? 0), 0);
  const tooLarge = totalBytes > EXTRACTION_STUDY_INSPECTION_MAX_BYTES;
  const capacityMessage = t('文件或请求超过 128 MiB。请使用容量范围内的完整冻结研究，不裁剪计划项或失败结果。', 'Files or request exceed 128 MiB. Use a complete frozen study that fits this capacity; keep every planned item and failed result.');
  useEffect(() => () => { version.current++; active.current?.abort(); }, []);
  function stop() { version.current++; active.current?.abort(); active.current = null; setBusy(false); }
  function close() { stop(); form.current?.reset(); setFiles({}); setResult(null); setError(''); setNotice(''); onClose(); }
  function choose(key: FileKey, file?: File) {
    stop(); setResult(null); setError(''); setNotice(''); setFilesOpen(true);
    const next = { ...files, [key]: file };
    setFiles(next);
    if (fileKeys.reduce((sum, name) => sum + (next[name]?.size ?? 0), 0) > EXTRACTION_STUDY_INSPECTION_MAX_BYTES) setError(capacityMessage);
  }
  async function inspect() {
    if (!files.evidence || busy || tooLarge || active.current) return;
    const sequence = ++version.current, controller = new AbortController(); active.current = controller;
    const current = () => sequence === version.current && !controller.signal.aborted;
    setBusy(true); setResult(null); setError(''); setNotice('');
    try {
      const payload: Partial<Record<FileKey, unknown>> = {};
      for (const key of fileKeys) {
        const file = files[key]; if (!file) continue;
        const text = await file.text(); if (!current()) return;
        try { payload[key] = JSON.parse(text) as unknown; }
        catch { throw new Error('study_file_json_invalid'); }
      }
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > EXTRACTION_STUDY_INSPECTION_MAX_BYTES) throw new Error('knowledge_study_capacity_exceeded');
      if (!current()) return;
      const inspected = await requestKnowledge<KnowledgeStudyInspection>('study', payload, controller.signal);
      if (!current()) return;
      setResult(inspected); setFilesOpen(false);
    } catch (cause) {
      if (!current()) return;
      const code = cause instanceof Error ? cause.message : '';
      setError(code === 'knowledge_study_capacity_exceeded' || code === 'request_body_too_large' ? capacityMessage
        : code === 'study_file_json_invalid' || code === 'knowledge_study_input_invalid'
          ? t('文件不是可用的研究 JSON。请选择导出的 evidence.json，并核对各回执文件后重试。', 'A file is not valid study JSON. Choose the exported evidence.json and check each review receipt before retrying.')
        : code === 'knowledge_study_busy'
          ? t('另一个研究核对正在运行。请等待结束后重试；所选文件已保留。', 'Another study inspection is running. Wait for it to finish and retry; the selected files are preserved.')
        : code === 'knowledge_study_unavailable'
          ? t('核对工作进程异常或已取消。请重试；没有调用模型或改写工作区。', 'The inspection worker failed or was cancelled. Retry; no model was called and no workspace was changed.')
        : code === 'knowledge_study_host_mismatch'
          ? t('当前安装版本与冻结研究的运行环境不一致。请使用原研究构建核对；所选文件已保留。', 'This installation differs from the frozen study runtime. Inspect with the original study build; the selected files are preserved.')
        : code === 'knowledge_study_evidence_invalid'
          ? t('来源、运行产物或回执未通过冻结身份校验。请核对原始证据与对应回执后重试。', 'Source, run or receipt identities did not validate. Check the original evidence and its matching receipts, then retry.')
          : t('暂时无法核对证据。请确认 Studio 仍在运行，然后重试；不会修改知识或调用模型。', 'Evidence inspection is unavailable. Check that Studio is running and retry; no knowledge is changed and no model is called.'));
    } finally { if (current()) { active.current = null; setBusy(false); } }
  }
  const labels: Record<FileKey, string> = { evidence: t('研究证据 evidence.json（必选）', 'Study evidence evidence.json (required)'),
    authorReceipt: t('参考标注作者自审回执', 'Reference author review receipt'), referenceReceipt: t('独立真人参考标注回执', 'Independent human reference receipt'),
    outputReceipt: t('输出复核回执', 'Output review receipt'), judgeReceipt: t('AI 评委回执（用于校准）', 'AI judge receipt (for calibration)') };
  const fileField = (key: FileKey) => <label className="knowledge-study-file" key={key} htmlFor={`${fileId}-${key}`}>
    <span>{labels[key]}</span><input id={`${fileId}-${key}`} type="file" required={key === 'evidence'} accept="application/json,.json" onChange={event => choose(key, event.target.files?.[0])}/>
    {files[key] && <Button type="link" onClick={() => { choose(key); const input = form.current?.querySelector<HTMLInputElement>(`[id="${fileId}-${key}"]`); if (input) input.value = ''; }}>{t('移除此文件', 'Remove this file')}</Button>}
  </label>;
  return <Drawer title={t('核对研究证据', 'Inspect study evidence')} open onClose={close} size="min(1080px, 100vw)" className="knowledge-study-drawer"
    extra={<Space wrap>{busy && <Button onClick={() => { stop(); setNotice(t('已取消核对。可以再次核对所选文件。', 'Inspection cancelled. You can inspect the selected files again.')); }}>{t('取消核对', 'Cancel inspection')}</Button>}
      <Button type="primary" aria-label={t('核对证据', 'Inspect evidence')} loading={busy} disabled={!files.evidence || tooLarge} onClick={() => void inspect()}>{t('核对证据', 'Inspect evidence')}</Button></Space>}>
    <div className="knowledge-study-shell">
      <p className="knowledge-study-intro">{t('选择导出的研究证据包，按需附上复核回执。核对不会调用模型或修改知识；关闭后清除本次选择与结果。', 'Choose an exported study evidence package and optional review receipts. Inspection calls no model and changes no knowledge; closing clears this session.')}</p>
      <details className={`knowledge-study-files${result ? ' has-result' : ''}`} open={filesOpen} onToggle={event => setFilesOpen(event.currentTarget.open)}>
        <summary>{t('选择／更换证据文件', 'Choose or replace evidence files')}{files.evidence && ` · ${files.evidence.name}`}</summary>
        <form ref={form} onSubmit={event => { event.preventDefault(); void inspect(); }}>
          {fileField('evidence')}
          <details><summary>{t('附上复核回执（可选）', 'Add review receipts (optional)')}</summary><div className="knowledge-study-optional-files">{fileKeys.slice(1).map(fileField)}</div></details>
          <p>{t('所有文件合计及序列化请求均不得超过 128 MiB。只选原始 evidence.json，不能用 report.json 中的状态代替证据。', 'Combined files and the serialized request must each fit within 128 MiB. Use evidence.json; reported status in report.json cannot replace evidence.')}</p>
        </form>
      </details>
      {error && <Alert type="error" showIcon title={error}/>} {notice && <p role="status">{notice}</p>}
      {busy ? <div className="knowledge-study-loading" role="status"><p>{t('正在本地核对冻结身份、来源与运行产物…', 'Checking frozen identities, sources and run evidence locally…')}</p><Skeleton active title={false} paragraph={{ rows: 3 }}/></div>
        : result ? <KnowledgeStudyInspectionView key={result.review.reportId} inspection={result} lang={lang}/>
          : <div className="knowledge-study-empty"><h3>{t('先选择研究证据包', 'Choose a study evidence package')}</h3><p>{t('没有真人回执也可以核对工程证据。未复核或证据不足会明确保留，不会按零错误处理。', 'You can inspect engineering evidence without human receipts. Missing reviews and incomplete evidence remain visible and are never treated as zero errors.')}</p></div>}
    </div>
  </Drawer>;
}

export function KnowledgeStudyInspectionView({ inspection: value, lang }: { inspection: KnowledgeStudyInspection; lang: Language }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [caseId, setCaseId] = useState(value.cases[0]?.caseId ?? ''), [arm, setArm] = useState(value.plan.variants[0]?.variantId ?? 'baseline');
  const [repeat, setRepeat] = useState(1), [panel, setPanel] = useState('source'), [reviewChannel, setReviewChannel] = useState('primary');
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const sample = value.cases.find(item => item.caseId === caseId);
  const repeats = [...new Set(value.slots.filter(item => item.caseId === caseId && item.variantId === arm).map(item => item.repeat))];
  const slot = value.slots.find(item => item.caseId === caseId && item.variantId === arm && item.repeat === repeat);
  const shownReview = reviewChannel === 'judge' && value.judgeReview ? value.judgeReview : value.review;
  const metrics = shownReview.slots.find(item => item.slotId === slot?.slotId)?.metrics;
  const decisions = shownReview.decisions.filter(item => item.target.slotId === slot?.slotId), missing = shownReview.missingTargets.filter(item => item.slotId === slot?.slotId);
  const status = (state: string) => state === 'accepted_within_scope' ? t('独立复核：仅在冻结范围内通过', 'Independent review: accepted within this frozen scope')
    : state === 'blocked' ? t('阻断：存在未解决问题', 'Blocked: unresolved issues')
    : state === 'exploratory_reviewed' ? t('探索性复核：尚未独立验收', 'Exploratory review: independent acceptance pending')
    : t('证据不足：仍需复核', 'Insufficient evidence: review pending');
  const number = (item: number | null | undefined) => item === null || item === undefined ? t('未知／未评估', 'Unknown / not assessed') : new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: 4 }).format(item);
  const annotation = sample?.reference.annotationScope === 'full' ? t('完整标注', 'Full annotation') : sample?.reference.annotationScope === 'critical_only' ? t('仅关键部分标注', 'Critical-only annotation') : t('未标注', 'Unannotated');
  return <section className="knowledge-study-result">
    <div className="knowledge-study-verdict" role="status">
      <h3 ref={heading} tabIndex={-1}>{status(value.review.status)}</h3>
      <p>{t('工程完整性：', 'Engineering evidence: ')}{value.analysis.assessment.engineering.planVerified && value.analysis.assessment.engineering.outputVerified ? t('冻结身份已核对', 'Frozen identities checked') : t('尚未完成核对', 'Not fully verified')}
        {' · '}{t('已完成运行：', 'Completed runs: ')}{value.summary.completed}／{value.summary.planned}
        {' · '}{t('独立参考标注：', 'Independent reference: ')}{value.review.reference.goldReady ? t('已复核', 'Reviewed') : t('未就绪', 'Not ready')}</p>
      <p>{t('输出复核：', 'Output review: ')}{value.review.outputReview.reviewed}／{value.review.outputReview.expected} · {t('不确定：', 'Uncertain: ')}{value.review.outputReview.uncertain} · {t('缺项：', 'Missing: ')}{value.review.missingTargets.length}</p>
      {value.judgeReview && <p>{t('AI 探索性复核：', 'AI exploratory review: ')}{status(value.judgeReview.status)} · {value.judgeReview.outputReview.reviewed}／{value.judgeReview.outputReview.expected} · {t('不确定：', 'Uncertain: ')}{value.judgeReview.outputReview.uncertain} · {t('缺项：', 'Missing: ')}{value.judgeReview.missingTargets.length}</p>}
      <p className="knowledge-study-limits">{t('结论仅限这份冻结研究集合。来源与真人独立性仍依赖声明；AI 评委材料未做原生验证。这里不评估总体准确率、版本发布资格或改造完成。', 'Conclusions apply only to this frozen study. Provenance and human independence remain attestations; AI judge artifacts are not native-verified. Population accuracy, release eligibility and project completion are not assessed here.')}</p>
    </div>
    {!!value.review.completionTime.unverifiedSlotIds.length && <Alert type="warning" showIcon title={t('完成时间未核实', 'Completion time unverified')}
      description={t('已完成记录缺少 finishedAt，不能取得完成后复核、匹配指标或校准就绪资格；不会补造时间。', 'Completed records lack finishedAt; post-completion review, matching metrics and calibration readiness are unavailable. No completion time is invented.')}/>}
    <div className="knowledge-study-filters">
      <label>{t('案例', 'Case')}<select value={caseId} onChange={event => { setCaseId(event.target.value); setRepeat(1); }}>{value.cases.map(item => <option value={item.caseId} key={item.caseId}>{item.caseId}</option>)}</select></label>
      <label>{t('版本', 'Arm')}<select value={arm} onChange={event => { setArm(event.target.value as typeof arm); setRepeat(1); }}>{value.plan.variants.map(item => <option value={item.variantId} key={item.variantId}>{item.variantId}</option>)}</select></label>
      <label>{t('重复执行', 'Repeat')}<select value={repeat} onChange={event => setRepeat(Number(event.target.value))}>{repeats.map(item => <option value={item} key={item}>{item}</option>)}</select></label>
      <label>{t('逐例视图', 'Case view')}<select value={panel} onChange={event => setPanel(event.target.value)}><option value="source">{t('原始依据', 'Source excerpts')}</option><option value="birth">{t('出生输出', 'Birth output')}</option><option value="review">{t('复核判定', 'Review decisions')}</option></select></label>
    </div>
    <div className="knowledge-study-evidence-scroll" key={slot?.slotId ?? caseId}>
      <p className="knowledge-study-case-meta">{caseId} · {annotation} · {sample?.exposure === 'seen' ? t('已见开发来源', 'Previously seen development source') : t('声明为未见来源', 'Declared unseen source')} · {sample?.stratumId} · {slot ? t(`运行状态：${slot.status}`, `Run status: ${slot.status}`) : t('没有对应运行', 'No matching run')}
        {slot && <> · {t('本地运行耗时：', 'Local run elapsed: ')}{number(slot.elapsedMs)} ms</>}</p>
      <p className="knowledge-study-help">{t('耗时包含生成、归档、写入和退避，不能作为人工复核耗时。便携身份只用于阅读，不会打开当前知识目录的修订或维护操作。', 'Elapsed time includes generation, archival, writes and backoff; it is not human review time. Portable identities are read-only and do not open editing or maintenance actions in the current workspace.')}</p>
      <details><summary>{t('工程摘要与冻结范围', 'Engineering summary and frozen scope')}</summary>
        <dl className="knowledge-study-facts"><dt>{t('研究计划', 'Study plan')}</dt><dd><code>{value.plan.planId}</code></dd><dt>{t('已声明时间', 'Declared at')}</dt><dd>{value.plan.declaredAt}</dd>
          <dt>{t('OMK 尝试／执行器报告尝试', 'OMK / executor-reported attempts')}</dt><dd>{value.summary.attempts}／{number(value.summary.executorReportedAttempts)}</dd>
          <dt>{t('已报告费用（USD）', 'Reported cost (USD)')}</dt><dd>{number(value.summary.totalCostUSD)}</dd><dt>{t('来源快照／来源版本', 'Source snapshot / version')}</dt><dd><code>{sample?.source.snapshotId}</code><br/><code>{sample?.source.sourceVersion}</code></dd>
          <dt>{t('运行／出生实体修订', 'Run / birth entity revision')}</dt><dd><code>{slot?.runId ?? t('未执行', 'Unattempted')}</code><br/><code>{slot?.birth?.revisionId ?? t('无出生修订', 'No birth revision')}</code></dd>
          <dt>{t('来源分组', 'Source grouping')}</dt><dd>{sample?.projectGroup}／{sample?.conversationGroup}／{sample?.lineageGroup}</dd></dl>
        {value.plan.variants.map(item => <p key={item.variantId}><strong>{item.variantId}</strong> · {item.executor} / {item.model} · {item.promptVersion} · <code>{item.policy.policyId}</code></p>)}
        <p>{t('选样与停止依据：', 'Sampling and stopping: ')}{value.plan.sampling.sampleSizeRationale} · {value.plan.sampling.stoppingRule}</p>
        <p>{t('提供者内部请求次数未获证明。', 'Provider-internal request counts are not attested.')}</p>
        <details><summary>{t('完整冻结声明', 'Complete frozen declarations')}</summary><pre>{JSON.stringify(value.plan, null, 2)}</pre></details>
      </details>
      {value.review.variants.map(item => <p className="knowledge-study-arm-status" key={item.variantId}><strong>{item.variantId}</strong> · {status(item.status)}{item.blockers.length > 0 && <span> · {item.blockers.join('、')}</span>}</p>)}
      {sample && panel === 'source' && <section><h3>{t('原始依据', 'Source excerpts')}</h3>
        <p>{t('来源采集时间：', 'Source captured at: ')}{sample.source.capturedAt} · {t('记录范围：', 'Record range: ')}{sample.source.startRecord}–{sample.source.endRecord}</p>
        <PageItems key={`${caseId}-source`} label={t('原始依据', 'Source excerpts')} items={sample.source.excerpts} lang={lang} renderItem={item => <><p><code>{item.evidenceRef}</code> · {item.role ?? item.eventKind}{item.timestamp && <> · {item.timestamp}</>}</p><blockquote>{item.text || t('（空消息）', '(Empty message)')}</blockquote></>}/>
        {sample.source.limitations.map((item, index) => <p className="knowledge-study-help" key={index}>{item}</p>)}
      </section>}
      {panel === 'birth' && <section><h3>{t('出生输出', 'Birth output')}</h3>
        {!slot?.birth ? <p>{t('没有可核对的出生输出。未执行、失败或未完成不表示零错误。', 'No birth output is available. Unattempted, failed or incomplete runs do not mean zero errors.')}</p>
          : <><h4>{t('实体', 'Entities')}</h4><PageItems label={t('实体', 'Entities')} items={slot.birth.entities} lang={lang} renderItem={item => <><strong>{item.label}</strong><p>{item.description}</p><p className="knowledge-study-help">{item.referentKind} · {item.identityStatus} · <code>{item.entityId}</code></p>{item.qualifiers.length > 0 && <p>{t('限定：', 'Qualifiers: ')}{item.qualifiers.join('；')}</p>}{item.uncertainties.map((text, index) => <p key={index}>{t('不确定：', 'Uncertainty: ')}{text}</p>)}</>}/>
            <h4>{t('精确提及', 'Exact mentions')}</h4><PageItems label={t('精确提及', 'Exact mentions')} items={slot.birth.mentions} lang={lang} renderItem={item => <><blockquote>{item.selection.quote}</blockquote><p><code>{item.mentionId}</code> → <code>{item.entityId}</code></p><p className="knowledge-study-help">{item.selection.evidenceRef} · UTF-16 [{item.selection.start}, {item.selection.end}) · {item.rationale}</p></>}/>
            <h4>{t('候选知识', 'Knowledge candidates')}</h4><PageItems label={t('候选知识', 'Knowledge candidates')} items={slot.birth.knowledge} lang={lang} renderItem={item => <details><summary>{item.title}</summary><p><code>{item.knowledgeId}</code>／<code>{item.revisionId}</code></p>
              <PageItems label={t('陈述', 'Statements')} items={item.content.statements} lang={lang} renderItem={statement => <article className="knowledge-study-statement"><h4>{statement.relation}</h4><p>{t('主体：', 'Subject: ')}{item.entities.find(entity => entity.entityId === statement.subject.entityId)?.label ?? statement.subject.entityId}{statement.object && <> · {t('客体：', 'Object: ')}{item.entities.find(entity => entity.entityId === statement.object?.entityId)?.label ?? statement.object.entityId}</>} · {statement.polarity} · {statement.modality}</p>
                <p>{statement.context.scenario}</p>{(['conditions', 'exceptions', 'unknowns'] as const).map(field => <p key={field}>{field === 'conditions' ? t('条件：', 'Conditions: ') : field === 'exceptions' ? t('例外：', 'Exceptions: ') : t('未知：', 'Unknowns: ')}{statement.context[field].join('；') || t('未提供', 'Not provided')}</p>)}
                <details><summary>{t('事实时间与适用时间', 'Occurrence and validity time')}</summary><pre>{JSON.stringify({ occurredDuring: statement.context.occurredDuring, validDuring: statement.context.validDuring }, null, 2)}</pre></details></article>}/>
              {item.evidence.map(link => <p key={link.evidenceLinkId}><code>{link.evidenceRef}</code> · {link.basis} · {link.interpretation}</p>)}{item.grounding.citations.map((citation, index) => <blockquote key={index}>{citation.selection.quote}<small>{citation.selection.evidenceRef} · {citation.evidenceLinkId}</small></blockquote>)}
            </details>}/></>}
      </section>}
      {panel === 'review' && <section><h3>{t('复核判定', 'Review decisions')}</h3>
        {value.judgeReview && <label className="knowledge-study-review-channel">{t('判定来源', 'Judgment source')}<select value={reviewChannel} onChange={event => setReviewChannel(event.target.value)}><option value="primary">{t('输出复核回执', 'Output review receipt')}</option><option value="judge">{t('AI 评委探索性回执', 'AI judge exploratory receipt')}</option></select></label>}
        <p>{t('判定：', 'Judgments: ')}{decisions.length} · {t('缺项：', 'Missing: ')}{missing.length} · {t('复核人：', 'Reviewer: ')}{shownReview.outputReview.reviewer?.actorId ?? t('尚未提供', 'Not supplied')}</p>
        {sample && <details><summary>{t('参考标注与应覆盖内容', 'Reference annotations and obligations')}</summary>
          <PageItems label={t('参考标注', 'Reference annotations')} lang={lang} items={[...sample.reference.entities, ...sample.reference.mentions, ...sample.reference.knowledge]}
            renderItem={item => <><strong>{item.referenceId}</strong><p>{item.description}</p><p>{t('等价表达：', 'Equivalent expressions: ')}{item.equivalentExpressions.join('；')}{'coverage' in item && <> · {item.coverage}</>}</p>{item.locators.map((locator, index) => <blockquote key={index}>{locator.quote}<small>{locator.evidenceRef} · {t('出现序号：', 'Occurrence: ')}{locator.occurrence ?? t('唯一出现', 'Unique')}</small></blockquote>)}</>}/>
          {sample.reference.semanticChecks.map(check => <p key={check.checkId}><code>{check.checkId}</code> · {check.description}</p>)}
        </details>}
        {missing.length > 0 && <details open><summary>{t('尚缺复核的目标', 'Targets still needing review')}</summary><PageItems label={t('缺少判定', 'Missing decisions')} items={missing} lang={lang} renderItem={item => <code>{targetLabel(item)}</code>}/></details>}
        <PageItems label={t('复核判定', 'Review decisions')} items={decisions} lang={lang} renderItem={item => <><strong>{decisionLabel(item.verdict, lang)}</strong><p><code>{targetLabel(item.target)}</code>{item.referenceId && <> · {t('参考：', 'Reference: ')}{item.referenceId}</>}</p><p>{item.rationale}</p>{item.errorCodes.length > 0 && <p>{t('错误类别：', 'Error classes: ')}{item.errorCodes.join('、')}</p>}</>}/>
        {metrics && <><h4>{t('该运行的范围内匹配指标', 'Scoped matching metrics for this run')}</h4>{(['entities', 'mentions'] as const).map(component => <dl className="knowledge-study-facts" key={component}><dt>{component === 'entities' ? t('实体', 'Entities') : t('提及', 'Mentions')}</dt><dd>{t('输出／参考：', 'Outputs / references: ')}{metrics[component].outputCount}／{metrics[component].referenceCount}</dd><dt>TP／FP／FN</dt><dd>{number(metrics[component].truePositive)}／{number(metrics[component].falsePositive)}／{number(metrics[component].falseNegative)}</dd><dt>Precision／Recall／F1</dt><dd>{number(metrics[component].precision)}／{number(metrics[component].recall)}／{number(metrics[component].f1)}</dd></dl>)}</>}
      </section>}
      <details className="knowledge-study-analysis"><summary>{t('范围内版本比较与评委校准', 'Scoped comparison and judge calibration')}</summary>
        <p>{t('比较单位：来源血缘组；配对缺失或未独立复核时不计算差值。', 'Comparison unit: source lineage group. No difference is computed for incomplete or non-independent pairs.')}</p>
        <p>{t('完整配对／计划来源组：', 'Complete pairs / planned groups: ')}{value.analysis.overall.paired.completePairs}／{value.analysis.overall.plannedGroups} · {t('候选减基线的组错误率差：', 'Candidate minus baseline group error rate: ')}{number(value.analysis.overall.paired.candidateMinusBaselineGroupErrorRate)}</p>
        {value.calibration ? <><p>{value.calibration.ready ? t('校准裁决齐全；尚未判定评委是否可用。', 'Calibration judgments are complete; judge eligibility is not assessed.') : t('校准证据不足；缺项与未知判定不会当作正确。', 'Calibration evidence is incomplete; missing or uncertain judgments are not treated as correct.')}</p>
          <p>{t('AI 评委：', 'AI judge: ')}{value.calibration.judgeEvidence.identity?.executor}／{value.calibration.judgeEvidence.identity?.model} · {value.calibration.judgeEvidence.identity?.modelRevision}</p>
          <p>{t('评委费用（USD）：', 'Judge cost (USD): ')}{number(value.calibration.judgeEvidence.usage.costUSD.total)} · {t('已报告部分：', 'Reported portion: ')}{number(value.calibration.judgeEvidence.usage.costUSD.knownTotal)}</p>
          <p>{t('已观察关键漏判：', 'Observed critical missed judgments: ')}{number(value.calibration.knownComparedTargets > 0 || value.calibration.criticalMisses.length > 0 ? value.calibration.criticalMisses.length : null)}</p>
          <p>{t('已对照／全部目标：', 'Compared / expected targets: ')}{value.calibration.knownComparedTargets}／{value.calibration.expectedTargets} · {t('未知或缺项：', 'Unknown or missing targets: ')}{value.calibration.unknownOrMissingTargets}</p>
          {value.calibration.criticalMisses.length > 0 && <PageItems label={t('已观察关键漏判', 'Observed critical missed judgments')} items={value.calibration.criticalMisses} lang={lang} renderItem={item => <><p><code>{targetLabel(item.target)}</code></p><p>{t('错误类别：', 'Error classes: ')}{item.errorCodes.join('、')} · {t('检测状态：', 'Detection status: ')}{item.detectionStatus === 'known_miss' ? t('已知漏判', 'Known miss') : t('评委判定未知', 'Judge judgment unknown')}</p></>}/>}
          <PageItems label={t('评委校准', 'Judge calibration')} items={value.calibration.byClass} lang={lang} renderItem={item => <p>{item.errorCode} · Precision {number(item.precision)} · Recall {number(item.recall)} · F1 {number(item.f1)}</p>}/>
        </> : <p>{t('尚未提供 AI 评委回执，未进行校准。', 'No AI judge receipt was supplied; calibration has not been performed.')}</p>}
        <details><summary>{t('完整范围与来源限制', 'Complete scope and provenance limits')}</summary>{[...value.limits, ...value.review.limits].map((item, index) => <p key={index}>{item}</p>)}</details>
      </details>
    </div>
  </section>;
}

function targetLabel(target: Target) {
  return `${target.itemKind}${'entityId' in target ? ` · ${target.entityId}` : 'mentionId' in target ? ` · ${target.mentionId}` : 'referenceId' in target ? ` · ${target.referenceId}` : 'checkId' in target ? ` · ${target.checkId}` : 'statementId' in target ? ` · ${target.knowledgeId} / ${target.statementId}` : ''}`;
}
function decisionLabel(verdict: string, lang: Language) {
  const labels: Record<string, [string, string]> = { correct: ['正确', 'Correct'], incorrect: ['错误', 'Incorrect'], uncertain: ['不确定', 'Uncertain'], required_missing: ['缺少必需内容', 'Required content missing'], optional_not_selected: ['可选内容未选择', 'Optional content not selected'] };
  return labels[verdict]?.[lang === 'zh' ? 0 : 1] ?? verdict;
}
function PageItems<T>({ items, renderItem, label, lang }: { items: readonly T[]; renderItem(item: T): ReactNode; label: string; lang: Language }) {
  const [page, setPage] = useState(1), pages = Math.max(1, Math.ceil(items.length / 12)), current = Math.min(page, pages);
  return <div className="knowledge-study-page">{items.length ? <ul>{items.slice((current - 1) * 12, current * 12).map((item, index) => <li key={(current - 1) * 12 + index}>{renderItem(item)}</li>)}</ul> : <p>{lang === 'zh' ? '没有此类记录。' : 'No records of this type.'}</p>}
    {pages > 1 && <nav aria-label={label}><Button aria-label={`${label} · ${lang === 'zh' ? '上一页' : 'Previous page'}`} disabled={current === 1} onClick={() => setPage(current - 1)}>{lang === 'zh' ? '上一页' : 'Previous'}</Button><span>{current}／{pages}</span><Button aria-label={`${label} · ${lang === 'zh' ? '下一页' : 'Next page'}`} disabled={current === pages} onClick={() => setPage(current + 1)}>{lang === 'zh' ? '下一页' : 'Next'}</Button></nav>}
  </div>;
}
