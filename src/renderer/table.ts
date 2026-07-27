import { e, fmtNum, fmtDuration, t } from './layout.js';
import type { Lang, ResultEntry, EnsembleJudgeResult, JudgeAgreement } from '../types/index.js';

/** Render the multi-judge ensemble breakdown for a single (sample × rubric or dimension). */
function renderEnsembleBlock(ensemble: EnsembleJudgeResult[] | undefined, agreement: JudgeAgreement | undefined, lang: Lang): string {
  if (!ensemble || ensemble.length < 2) return '';
  const rows = ensemble.map((judge) => {
    const stddev = judge.scoreStddev != null && judge.scoreStddev > 0
      ? ` <span style="color:var(--text-muted)">±${judge.scoreStddev}</span>`
      : '';
    const fail = judge.judgeFailureCount && judge.judgeFailureCount > 0
      ? ` <span style="color:var(--red);font-size:11px">${judge.judgeFailureCount}/${judge.scoreSamples?.length || '?'} fail</span>`
      : '';
    const reasoning = judge.reasoning
      ? `<details class="sc-cot"><summary>${t('judgeReasoning', lang)} ${t('judgeReasoningExpand', lang)}</summary><pre class="sc-cot-body">${e(judge.reasoning)}</pre></details>`
      : '';
    return `<div style="margin-top:6px;font-size:13px"><strong>${e(judge.judge)}</strong>: ${judge.score}${stddev}${fail}${reasoning}</div>`;
  }).join('');
  const agreementLine = agreement && agreement.pairCount > 0
    ? `<div style="margin-top:6px;font-size:12px;color:var(--text-muted)" title="${t('madDesc', lang)}">MAD ${agreement.meanAbsDiff}${agreement.pearson != null ? ` · Pearson ${agreement.pearson}` : ''}</div>`
    : '';
  return `<details class="sc-section"><summary class="sc-section-h" style="cursor:pointer">${t('ensembleHeader', lang)} (${ensemble.length})</summary>${rows}${agreementLine}</details>`;
}

/**
 * 渲染单个 variant 在某个 sample 上的"评分卡片块"。
 * 结构化分段:综合分 → 三层分(事实/行为/LLM 评价)→ 失败断言 → judge 推理 → 工具调用统计。
 * 每段独立展示,文本左对齐,数字 tabular-nums 对齐。
 *
 * delta(对比第 1 个 variant)只在多 variant 模式下显示。
 */
function renderVariantBlock(d: import('../types/index.js').VariantResult, variantName: string, comparedTo: import('../types/index.js').VariantResult | undefined, lang: Lang): string {
  const score = d.compositeScore ?? d.llmScore;
  const hasScore = typeof score === 'number';
  const scoreText = hasScore ? score : (d.ok ? '—' : 'ERR');
  const scoreColor = !d.ok ? 'var(--red)' : (hasScore && score >= 4) ? 'var(--green)' : (hasScore && score >= 3) ? 'var(--yellow)' : (hasScore ? 'var(--red)' : 'var(--text-muted)');

  // Judge 自一致性指标(单评分模式 ≥2 次评委时):stddev + failure count
  let stabilityHtml = '';
  if (d.llmScoreSamples && d.llmScoreSamples.length > 1) {
    if (d.llmScoreStddev != null) {
      stabilityHtml += ` <span class="sc-stab" title="${t('judgeStddevDesc', lang)}">±${d.llmScoreStddev}</span>`;
    }
    if (d.llmScoreFailures && d.llmScoreFailures > 0) {
      stabilityHtml += ` <span class="sc-stab sc-stab--fail" title="${t('judgeFailuresDesc', lang)}">${d.llmScoreFailures}/${d.llmScoreSamples.length} fail</span>`;
    }
  }

  // delta 跟首 variant(通常是 baseline)的差值
  let scoreDelta = '';
  if (comparedTo && hasScore && typeof comparedTo.compositeScore === 'number') {
    const diff = score - comparedTo.compositeScore;
    if (Math.abs(diff) >= 0.05) {
      const sign = diff > 0 ? '+' : '';
      const dColor = diff > 0 ? 'var(--green)' : 'var(--red)';
      scoreDelta = `<span style="color:${dColor};font-size:13px;margin-left:8px;font-weight:600">${sign}${diff.toFixed(2)}</span>`;
    }
  }

  // 三层分
  const ls = d.layeredScores;
  const layerRows: string[] = [];
  if (ls?.factScore != null) {
    const dColor = ls.factScore >= 4 ? 'var(--green)' : ls.factScore >= 3 ? 'var(--yellow)' : 'var(--red)';
    layerRows.push(`<div class="sc-layer-row"><span class="sc-layer-name">${lang === 'zh' ? '事实' : 'Fact'}</span><span class="sc-layer-val" style="color:${dColor}">${ls.factScore}</span></div>`);
  }
  if (ls?.behaviorScore != null) {
    const dColor = ls.behaviorScore >= 4 ? 'var(--green)' : ls.behaviorScore >= 3 ? 'var(--yellow)' : 'var(--red)';
    layerRows.push(`<div class="sc-layer-row"><span class="sc-layer-name">${lang === 'zh' ? '行为' : 'Behavior'}</span><span class="sc-layer-val" style="color:${dColor}">${ls.behaviorScore}</span></div>`);
  }
  if (ls?.judgeScore != null) {
    const dColor = ls.judgeScore >= 4 ? 'var(--green)' : ls.judgeScore >= 3 ? 'var(--yellow)' : 'var(--red)';
    layerRows.push(`<div class="sc-layer-row"><span class="sc-layer-name">${lang === 'zh' ? 'LLM 评价' : 'Judge'}</span><span class="sc-layer-val" style="color:${dColor}">${ls.judgeScore}</span></div>`);
  }
  const layeredHtml = layerRows.length > 0 ? `<div class="sc-layers">${layerRows.join('')}</div>` : '';

  // 失败断言(只列 fail 的)
  let assertionHtml = '';
  if (d.assertions?.details) {
    const failed = d.assertions.details.filter((a) => !a.passed);
    const total = d.assertions.details.length;
    if (failed.length > 0) {
      const items = failed.map((a) => `<li><code>${e(a.type)}</code>: ${e(String(a.value))}</li>`).join('');
      assertionHtml = `<div class="sc-section"><div class="sc-section-h">${lang === 'zh' ? '失败断言' : 'Failed assertions'} <span class="sc-stat">${failed.length}/${total}</span></div><ul class="sc-assert-list">${items}</ul></div>`;
    } else if (total > 0) {
      assertionHtml = `<div class="sc-section sc-section--muted">${lang === 'zh' ? '断言全过' : 'All passed'} <span class="sc-stat">${total}/${total}</span></div>`;
    }
  }

  // Judge 评价
  let judgeHtml = '';
  if (d.llmReason) {
    const reasonText = d.llmReason.length > 200 ? d.llmReason.slice(0, 200) + '…' : d.llmReason;
    const cot = d.llmReasoning
      ? `<details class="sc-cot"><summary>${lang === 'zh' ? '展开完整 CoT' : 'show full CoT'}</summary><pre class="sc-cot-body">${e(d.llmReasoning)}</pre></details>`
      : '';
    judgeHtml = `<div class="sc-section"><div class="sc-section-h">${lang === 'zh' ? 'Judge 评价' : 'Judge'}</div><div class="sc-judge-text">${e(reasonText)}</div>${cot}</div>`;
  }
  // Multi-judge ensemble (collapsed)
  const ensembleHtml = renderEnsembleBlock(d.llmEnsemble, d.llmAgreement, lang);

  // 维度评分(multi-rubric mode)
  let dimHtml = '';
  if (d.dimensions && Object.keys(d.dimensions).length > 0) {
    const dimRows = Object.entries(d.dimensions).map(([dim, info]) => {
      const s = typeof info === 'object' ? info.score : info;
      const dColor = (typeof s === 'number' && s >= 4) ? 'var(--green)' : (typeof s === 'number' && s >= 3) ? 'var(--yellow)' : 'var(--red)';
      return `<div class="sc-layer-row"><span class="sc-layer-name">${e(dim)}</span><span class="sc-layer-val" style="color:${dColor}">${s}</span></div>`;
    }).join('');
    dimHtml = `<div class="sc-section"><div class="sc-section-h">${lang === 'zh' ? '维度评分' : 'Dimensions'}</div><div class="sc-layers">${dimRows}</div></div>`;
  }

  // 事实校验
  let factCheckHtml = '';
  if (d.factCheck && d.factCheck.totalCount > 0) {
    const fc = d.factCheck;
    const fcColor = fc.verifiedRate >= 0.8 ? 'var(--green)' : fc.verifiedRate >= 0.5 ? 'var(--yellow)' : 'var(--red)';
    factCheckHtml = `<div class="sc-meta-row"><span class="sc-meta-name">${lang === 'zh' ? '事实校验' : 'Fact verified'}</span><span style="color:${fcColor}">${fc.verifiedCount}/${fc.totalCount}</span></div>`;
  }

  // 工具调用 + tokens + 耗时
  const totalMs = d.timing?.totalMs || d.durationMs;
  const metaParts: string[] = [];
  if (d.numToolCalls != null && d.numToolCalls > 0) {
    const hasResolvedOutcome = d.toolSuccessRate != null;
    const srColor = hasResolvedOutcome
      ? d.toolSuccessRate! >= 0.8 ? 'var(--green)' : 'var(--red)'
      : 'var(--text-muted)';
    const outcomeSuffix = [
      (d.numToolCancelled ?? 0) > 0
        ? lang === 'zh' ? `${d.numToolCancelled} 次取消` : `${d.numToolCancelled} cancelled`
        : '',
      (d.numToolUnknown ?? 0) > 0
        ? lang === 'zh' ? `${d.numToolUnknown} 次状态未知` : `${d.numToolUnknown} unknown`
        : '',
    ].filter(Boolean).map((value) => ` · ${value}`).join('');
    const outcomeText = hasResolvedOutcome
      ? `${(d.toolSuccessRate! * 100).toFixed(0)}% OK${outcomeSuffix}`
      : outcomeSuffix
        ? outcomeSuffix.replace(/^ · /, '')
        : lang === 'zh'
          ? `${d.numToolCalls} 次状态未知`
          : `${d.numToolCalls} unknown`;
    metaParts.push(`<div class="sc-meta-row"><span class="sc-meta-name">${lang === 'zh' ? '工具调用' : 'Tools'}</span>${d.numToolCalls} <span style="color:${srColor}">(${outcomeText})</span></div>`);
  }
  metaParts.push(`<div class="sc-meta-row"><span class="sc-meta-name">${lang === 'zh' ? 'Tokens' : 'Tokens'}</span>${d.tokenUsageReportedByExecutor === false ? '—' : fmtNum(d.totalTokens)}</div>`);
  metaParts.push(`<div class="sc-meta-row"><span class="sc-meta-name">${lang === 'zh' ? '耗时' : 'Duration'}</span>${fmtDuration(totalMs)}</div>`);

  // Error message
  const errorHtml = !d.ok && d.error
    ? `<div class="sc-error">⚠ ${e(d.error)}</div>`
    : '';

  return `<div class="sc-variant">
    <div class="sc-variant-h">${e(variantName)}</div>
    <div class="sc-score-line"><span class="sc-score" style="color:${scoreColor}">${scoreText}</span><span class="sc-score-unit">/ 5</span>${scoreDelta}${stabilityHtml}</div>
    ${layeredHtml}
    ${errorHtml}
    ${assertionHtml}
    ${dimHtml}
    ${judgeHtml}
    ${ensembleHtml}
    ${factCheckHtml ? `<div class="sc-section">${factCheckHtml}</div>` : ''}
    <div class="sc-meta">${metaParts.join('')}</div>
  </div>`;
}

export function renderSampleTable(variants: string[], results: ResultEntry[], lang: Lang): string {
  // v0.30 — 不再用宽表格(每 td 塞 15 种内容居中显示乱);
  // 改成"用例可折叠卡片",点击展开看 variant-by-variant 的结构化评分块。
  // 每条用例先按综合分升序(差的在前),便于聚焦问题样本。
  const sortedResults = [...results].sort((a, b) => {
    // 取首 variant 的 composite,按升序排
    const sa = a.variants?.[variants[0]]?.compositeScore ?? 0;
    const sb = b.variants?.[variants[0]]?.compositeScore ?? 0;
    return sa - sb;
  });

  const sampleCards = sortedResults.map((r) => {
    // 头部摘要:sample_id + 各 variant 的 score 一行带过
    const scoreSummary = variants.map((v) => {
      const d = r.variants?.[v];
      const score = d?.compositeScore ?? d?.llmScore;
      if (typeof score !== 'number') return `<span class="sc-summary-score sc-summary-score--muted">${e(v)} —</span>`;
      const color = score >= 4 ? 'var(--green)' : score >= 3 ? 'var(--yellow)' : 'var(--red)';
      return `<span class="sc-summary-score" style="color:${color}">${e(v)} ${score.toFixed(2)}</span>`;
    }).join('<span class="sc-summary-sep">·</span>');

    // 体内每个 variant 一栏(side-by-side),传 baseline (variants[0]) 用于 delta
    const baselineResult = r.variants?.[variants[0]];
    const variantBlocks = variants.map((v, i) => {
      const d = r.variants?.[v];
      if (!d) return `<div class="sc-variant"><div class="sc-variant-h">${e(v)}</div><div class="sc-empty">—</div></div>`;
      // 跟 baseline 比;baseline 自身不显示 delta
      return renderVariantBlock(d, v, i === 0 ? undefined : baselineResult, lang);
    }).join('');

    return `<details class="sc-sample-card">
      <summary class="sc-sample-h">
        <code class="sc-sample-id">${e(r.sample_id)}</code>
        <span class="sc-sample-scores">${scoreSummary}</span>
      </summary>
      <div class="sc-sample-body">
        <div class="sc-variants" data-cols="${variants.length}">${variantBlocks}</div>
      </div>
    </details>`;
  }).join('');

  return `
    <h2 data-i18n="perSampleDetail">${t('perSampleDetail', lang)}</h2>
    <div class="sc-sample-list">${sampleCards}</div>
    <style>
    /* 评分页 — 逐用例详情卡片(替代旧 table)
       结构:
         .sc-sample-list   外层 stack
           .sc-sample-card    一条用例,可折叠 details
             .sc-sample-h     头(id + 各 variant 分数摘要)
             .sc-sample-body  体
               .sc-variants    grid 多列(每 variant 一栏)
                 .sc-variant     单 variant 评分块
       关键:文本左对齐,数字右对齐 + tabular-nums,分段而非表格,
       减少居中混排和长短文本拥挤。 */
    .sc-sample-list { display:flex;flex-direction:column;gap:8px;margin:12px 0 }
    .sc-sample-card { background:var(--bg-surface);border-radius:var(--radius);box-shadow:var(--shadow-sm);transition:box-shadow .15s }
    .sc-sample-card:hover { box-shadow:var(--shadow-md) }
    .sc-sample-card[open] { box-shadow:var(--shadow-md) }
    .sc-sample-h { display:flex;align-items:center;gap:14px;padding:14px 18px;cursor:pointer;list-style:none;font-size:14.5px }
    .sc-sample-h::-webkit-details-marker { display:none }
    .sc-sample-h::after { content:'›';margin-left:auto;color:var(--text-muted);font-size:18px;transition:transform .15s }
    .sc-sample-card[open] .sc-sample-h::after { transform:rotate(90deg) }
    .sc-sample-id { font-family:"SF Mono",Menlo,monospace;color:var(--text-muted);font-size:13px;font-weight:500;letter-spacing:-0.01em }
    .sc-sample-scores { display:flex;align-items:center;gap:8px;font-size:13px;font-variant-numeric:tabular-nums;color:var(--text-secondary) }
    .sc-summary-score { font-family:"SF Mono",Menlo,monospace;font-weight:500 }
    .sc-summary-score--muted { color:var(--text-muted) }
    .sc-summary-sep { color:var(--text-muted) }
    .sc-sample-body { padding:0 18px 18px;border-top:1px solid var(--border) }
    /* 多列 grid:1 variant 用单列;2 用 1fr 1fr;>=3 自适应 */
    .sc-variants { display:grid;gap:24px;margin-top:18px;grid-template-columns:1fr }
    .sc-variants[data-cols="2"] { grid-template-columns:1fr 1fr }
    .sc-variants[data-cols="3"] { grid-template-columns:repeat(3,1fr) }
    .sc-variants[data-cols="4"] { grid-template-columns:repeat(2,1fr) }
    @media (max-width:760px){ .sc-variants, .sc-variants[data-cols="2"], .sc-variants[data-cols="3"], .sc-variants[data-cols="4"] { grid-template-columns:1fr } }
    .sc-variant { background:var(--bg-soft);border-radius:6px;padding:14px 16px;font-size:14px;line-height:1.7 }
    .sc-variant-h { font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:8px;letter-spacing:0.02em;font-family:"SF Mono",Menlo,monospace }
    .sc-score-line { display:flex;align-items:baseline;gap:6px;margin-bottom:14px }
    .sc-score { font-size:32px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1 }
    .sc-score-unit { font-size:14px;color:var(--text-muted);font-weight:400 }
    .sc-stab { font-size:12px;color:var(--text-muted);margin-left:8px;font-family:"SF Mono",Menlo,monospace;background:var(--bg-soft);padding:2px 6px;border-radius:3px }
    .sc-stab--fail { color:var(--red);background:var(--red-bg) }
    .sc-layers { display:flex;flex-direction:column;gap:4px;margin-bottom:8px }
    .sc-layer-row { display:flex;justify-content:space-between;align-items:baseline;font-size:13.5px;line-height:1.6 }
    .sc-layer-name { color:var(--text-secondary) }
    .sc-layer-val { font-weight:600;font-variant-numeric:tabular-nums;font-family:"SF Mono",Menlo,monospace }
    .sc-section { margin-top:14px }
    .sc-section--muted { color:var(--text-muted);font-size:13px }
    .sc-section-h { font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:6px }
    .sc-stat { color:var(--text-muted);font-weight:400;margin-left:6px;font-variant-numeric:tabular-nums }
    .sc-assert-list { margin:0;padding-left:20px;font-size:13px;line-height:1.7;color:var(--text-secondary) }
    .sc-assert-list li { margin:3px 0 }
    .sc-assert-list code { font-family:"SF Mono",Menlo,monospace;background:var(--bg-surface);padding:1px 6px;border-radius:3px;font-size:12px }
    .sc-judge-text { font-size:13.5px;line-height:1.7;color:var(--text-primary);white-space:pre-wrap;word-break:break-word }
    .sc-cot { margin-top:8px;font-size:12px }
    .sc-cot summary { cursor:pointer;color:var(--text-muted) }
    .sc-cot-body { font-size:12.5px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap;font-family:inherit;background:var(--bg-surface);padding:10px 14px;border-radius:4px;margin-top:6px;max-height:400px;overflow-y:auto }
    .sc-meta { margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:4px }
    .sc-meta-row { display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-muted);font-variant-numeric:tabular-nums }
    .sc-meta-name { color:var(--text-muted) }
    .sc-error { margin-top:10px;padding:10px 14px;background:var(--red-bg);border-left:3px solid var(--red);border-radius:4px;font-size:13px;color:var(--red);line-height:1.6 }
    .sc-empty { color:var(--text-muted);font-style:italic;padding:14px 0 }
    </style>`;
}
