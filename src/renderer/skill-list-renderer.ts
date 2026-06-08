/**
 * Skill 列表页 — 仪表盘布局，精确参照 aima-knowledge SkillHealth。
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import { assessHealth } from './skill-detail-renderer.js';
import type { Lang, SkillIndex, SkillIndexEntry, Insight } from '../types/index.js';

// ── icons (Lucide SVG inline, size=14) ──
const IC = {
  stethoscope: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/></svg>',
  testTubes: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v17.5A2.5 2.5 0 0 1 6.5 22v0A2.5 2.5 0 0 1 4 19.5V2"/><path d="M20 2v17.5a2.5 2.5 0 0 1-2.5 2.5v0a2.5 2.5 0 0 1-2.5-2.5V2"/><path d="M3 2h7"/><path d="M14 2h7"/><path d="M9 16H4"/><path d="M20 16h-5"/></svg>',
  eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  checkCircle: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  alertTri: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  xCircle: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  helpCircle: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return '';
  try { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } catch { return ''; }
}
function fmtShort(ts: string | null | undefined): string {
  if (!ts) return '-';
  try { const d = new Date(ts); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } catch { return '-'; }
}
function scoreColor(s: number): string { return s >= 100 ? '#1f9d63' : s >= 60 ? '#d97706' : '#dc2626'; }

interface Agg { totalSkills: number; dP: number; dW: number; dF: number; eP: number; eF: number; eSamples: number; eAvg: number | null; eAssertP: number; eAssertT: number; withObs: number; lastTs: string | null; gc: Record<string, number>; greenCt: number; composite: number | null; dHist: number[]; eHist: number[]; oHist: number[] }

function aggregate(entries: SkillIndexEntry[], iMap: Map<string, Insight[]>, lang: Lang): Agg {
  let dP = 0, dW = 0, dF = 0, eP = 0, eF = 0, eSamples = 0, eSum = 0, eCt = 0, withObs = 0, hSum = 0, hCt = 0;
  let eAssertP = 0, eAssertT = 0;
  const gc: Record<string, number> = { excellent: 0, good: 0, fair: 0, unhealthy: 0, unscored: 0 };
  const dH: number[] = [], eH: number[] = [], oH: number[] = [];
  for (const ent of entries) {
    const h = assessHealth(ent, iMap.get(ent.skillName) ?? [], lang);
    gc[h.grade]++;
    if (h.score != null) { hSum += h.score; hCt++; }
    if (ent.doctor) { dP += ent.doctor.passCount; dW += ent.doctor.warnCount; dF += ent.doctor.failCount; }
    if (ent.eval) { eP += ent.eval.passCount; eF += ent.eval.failCount; eSamples += ent.eval.totalSamples; if (ent.eval.compositeScore != null) { eSum += ent.eval.compositeScore; eCt++; } eAssertP += ent.eval.passCount; eAssertT += ent.eval.passCount + ent.eval.failCount; }
    if (ent.observe) withObs++;
    for (const x of ent.doctorHistory) { const t = x.passCount + x.warnCount + x.failCount; if (t > 0) dH.push(Math.round((x.passCount / t) * 100)); }
    for (const x of ent.evalHistory) { if (x.compositeScore != null) eH.push(Math.round((x.compositeScore / 5) * 100)); }
    for (const x of ent.observeHistory) oH.push(Math.round((1 - x.gapRate) * 100));
  }
  return { totalSkills: entries.length, dP, dW, dF, eP, eF, eSamples, eAvg: eCt > 0 ? eSum / eCt : null, eAssertP, eAssertT, withObs, lastTs: entries.flatMap((x) => [x.doctor?.timestamp, x.eval?.timestamp, x.observe?.generatedAt]).filter((x): x is string => Boolean(x)).sort().pop() ?? null, gc, greenCt: gc.good + gc.excellent, composite: hCt > 0 ? Math.round(hSum / hCt) : null, dHist: dH, eHist: eH, oHist: oH };
}

function spark(vals: number[], w: number, h: number): string {
  if (vals.length < 2) return `<div class="ep-chart"><span class="ep-chart-empty">暂无历史数据</span></div>`;
  const p = 6, pw = w - p * 2, ph = h - p * 2;
  const mn = Math.min(...vals), mx = Math.max(...vals), rg = mx - mn || 1;
  const coords = vals.map((v, i) => [p + (i / (vals.length - 1)) * pw, p + ph - ((v - mn) / rg) * ph]);
  const clr = vals[vals.length - 1] >= vals[0] ? '#1f9d63' : '#dc2626';
  let d = `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1], [x1, y1] = coords[i];
    const cp = (x1 - x0) * 0.4;
    d += ` C${(x0 + cp).toFixed(1)},${y0.toFixed(1)} ${(x1 - cp).toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return `<div class="ep-chart"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${clr}" stroke-width="1.5" stroke-linecap="round"/></svg></div>`;
}

function ring(score: number | null, size: number, sw: number): string {
  const r = (size - sw) / 2, c = 2 * Math.PI * r, off = c * (1 - (score ?? 0) / 100), clr = score != null ? scoreColor(score) : '#9ca3af', cx = size / 2;
  return `<div style="position:relative;width:${size}px;height:${size}px"><svg width="${size}" height="${size}"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#edf0f7" stroke-width="${sw}"/>${score != null ? `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${clr}" stroke-width="${sw}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cx})" style="transition:stroke-dashoffset .6s"/>` : ''}</svg><div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center"><span style="font-size:28px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;color:${clr}">${score ?? '—'}</span></div></div>`;
}

function bar(score: number | null): string {
  const p = score ?? 0, c = score != null ? scoreColor(score) : '#edf0f7';
  return `<div class="ep-bar"><div class="ep-bar-fill" style="width:${p}%;background:${c}"></div></div>`;
}

function renderPanel(a: Agg, lang: Lang): string {
  const zh = lang === 'zh';
  const dTotal = a.dP + a.dW + a.dF;
  const dScore = dTotal > 0 ? Math.round(((a.dP + a.dW * 0.5) / dTotal) * 100) : null;
  const eScore = a.eAvg != null ? Math.round((a.eAvg / 5) * 100) : null;
  const dClr = dScore != null ? scoreColor(dScore) : '#9ca3af';
  const eClr = eScore != null ? scoreColor(eScore) : '#9ca3af';

  return `<div class="ep">
  <div class="ep-grad"></div>
  <div class="ep-top">
    <div class="ep-top-left">
      <div class="ep-title-row">
        <span class="ep-brand">Omk 评测</span>
        <h1>${zh ? 'Skill 健康评测工作台' : 'Skill Health Dashboard'}</h1>
      </div>
      <span class="ep-meta">⏱ ${fmtDate(a.lastTs)} &nbsp;&nbsp; 📋 ${a.totalSkills} skill</span>
    </div>
  </div>
  <div class="ep-strip">
    <div class="ep-strip-score">
      ${ring(a.composite, 86, 6)}
      <span class="ep-score-lbl" onclick="document.getElementById('ep-help-modal').style.display='flex'">${zh ? '综合健康' : 'Health'} ${IC.helpCircle}</span>
    </div>
    <div class="ep-sep"></div>
    <div class="ep-dims">

      <div class="ep-dim">
        <div class="ep-dim-hd">${IC.stethoscope}<span>${zh ? '健康体检' : 'Doctor'}</span><strong style="color:${dClr}">${dScore ?? '—'}</strong></div>
        ${bar(dScore)}
        <div class="ep-dim-chk">${dTotal > 0
          ? `<span class="c-pass">${IC.checkCircle} ${zh ? '通过' : 'Pass'} <b>${a.dP}</b></span><span class="c-warn">${IC.alertTri} ${zh ? '警告' : 'Warn'} <b>${a.dW}</b></span><span class="c-fail">${IC.xCircle} ${zh ? '失败' : 'Fail'} <b>${a.dF}</b></span>`
          : `<span class="c-na">${zh ? '未运行' : 'Not run'}</span>`}</div>
        <div class="ep-dim-hint">${zh ? '检查 skill 结构合规性：文件规范、配置完整性等' : 'Structural compliance checks'}</div>
        ${spark(a.dHist.slice(-10), 200, 32)}
      </div>

      <div class="ep-dim">
        <div class="ep-dim-hd">${IC.testTubes}<span>${zh ? '用例评测' : 'Eval'}</span><strong style="color:${eClr}">${eScore ?? '—'}</strong></div>
        ${bar(eScore)}
        <div class="ep-dim-chk">${a.eAssertT > 0
          ? `<span class="c-pass">${IC.checkCircle} ${zh ? '断言通过' : 'Assert'} <b>${a.eAssertP}/${a.eAssertT}</b></span><span class="c-na">${zh ? '均分' : 'Avg'} <b>${a.eAvg != null ? a.eAvg.toFixed(1) : '—'}/5</b></span><span class="c-na">${zh ? '用例数' : 'Samples'} <b>${a.eSamples}</b></span>`
          : `<span class="c-na">${zh ? '未运行' : 'Not run'}</span>`}</div>
        <div class="ep-dim-hint">${zh ? '执行测试用例验证 skill 输出质量与断言准确率' : 'Test sample quality & assertion accuracy'}</div>
        ${spark(a.eHist.slice(-10), 200, 32)}
      </div>

      <div class="ep-dim">
        <div class="ep-dim-hd">${IC.eye}<span>${zh ? '生产观察' : 'Observe'}</span><strong class="ep-dim-na">${a.withObs > 0 ? a.withObs : (zh ? '暂无数据' : 'N/A')}</strong></div>
        ${a.withObs > 0 ? bar(null) : ''}
        ${a.withObs > 0
          ? `<div class="ep-dim-chk"><span class="c-pass">${a.withObs} ${zh ? '个 skill 有数据' : 'with data'}</span></div>`
          : `<div class="ep-dim-empty">${zh ? '尚无线上调用记录，数据将在 skill 被调用后自动采集' : 'No traces yet. Auto-collected when skills are invoked.'}</div>`}
        <div class="ep-dim-hint">${zh ? '线上工具调用成功率与调用量统计' : 'Online tool call metrics'}</div>
        ${spark(a.oHist.slice(-10), 200, 32)}
      </div>

    </div>
  </div>
  <div class="ep-footer">💡 ${zh ? '以上为评测汇总指标，如需查看失败原因等明细，请点击下方 skill 进入详情页查看' : 'Click a skill below for details'}</div>
</div>

<div id="ep-help-modal" class="ep-modal-overlay" onclick="if(event.target===this)this.style.display='none'">
  <div class="ep-modal">
    <div class="ep-modal-head"><strong>${zh ? '综合健康计算说明' : 'Health Score'}</strong><button onclick="document.getElementById('ep-help-modal').style.display='none'">✕</button></div>
    <div class="ep-modal-body">
      <p><b>${zh ? '综合健康' : 'Overall Health'}</b> = ${zh ? '各 skill 综合分的算术平均' : 'Arithmetic mean of per-skill composites'}。</p>
      <p>${zh ? '单 skill 综合分 = (健康体检 + 用例评测) / 2，任一维度 < 40 时该 skill 封顶 59 分（避免跛脚 skill 拉高整体）。' : 'Per-skill = (doctor + eval) / 2, capped at 59 if any dim < 40.'}</p>
      <p>${zh ? '下方三维度数字按业务量加权聚合：体检按规则数、评测按用例数、观察按工具调用量。' : 'Dimensions are weighted by volume: rules, samples, invocations.'}</p>
      <p>${zh ? '≥70 通过 / 50-69 待改进 / <50 不合格。' : '≥70 pass / 50-69 fair / <50 fail.'}</p>
    </div>
  </div>
</div>`;
}

// renderSkillModal 已移除:首页点行直接进 skill 详情页(doctor/eval/observe 已在该页合一),弹框预览冗余。

function renderRow(entry: SkillIndexEntry, insights: Insight[], langQ: string, lang: Lang): string {
  const h = assessHealth(entry, insights, lang);
  // 点行直接进该 skill 最新 eval 报告(无 eval 则最新 doctor);跨维度/历史在报告页内切换。
  const amp = lang === DEFAULT_LANG ? '' : `&lang=${lang}`;
  const href = entry.eval
    ? `/reports/${encodeURIComponent(entry.eval.reportId)}${langQ}`
    : entry.doctor
      ? `/doctors/${encodeURIComponent(entry.doctor.reportId)}?skill=${encodeURIComponent(entry.skillName)}${amp}`
      : `/runs${langQ}`;
  const dT = entry.doctor ? entry.doctor.passCount + entry.doctor.warnCount + entry.doctor.failCount : 0;
  const dP = dT > 0 ? Math.round(((entry.doctor!.passCount + entry.doctor!.warnCount * 0.5) / dT) * 100) : null;
  const eP = entry.eval?.compositeScore != null ? Math.round((entry.eval.compositeScore / 5) * 100) : null;
  const oP = entry.observe ? Math.round((1 - entry.observe.gapRate) * 100) : null;
  const mkBar = (p: number | null, t: string) => { const c = p != null ? scoreColor(p) : '#edf0f7'; return `<div class="t-bar" title="${e(t)} ${p ?? '—'}"><div class="t-bar-f" style="width:${p ?? 0}%;background:${c}"></div></div>`; };
  const hasScore = h.score != null;
  const clr = hasScore ? scoreColor(h.score!) : '#9ca3af';
  const lastTs = [entry.doctor?.timestamp, entry.eval?.timestamp, entry.observe?.generatedAt].filter((s): s is string => Boolean(s)).sort().pop() ?? null;
  const reportCount = entry.doctorHistory.length + entry.evalHistory.length + entry.observeHistory.length;

  const zh = lang === 'zh';
  let doctorStatus: string;
  if (!entry.doctor) {
    doctorStatus = `<span class="t-dash">—</span>`;
  } else if (entry.doctor.failCount === 0 && entry.doctor.warnCount === 0) {
    doctorStatus = `<span class="t-chk t-chk--ok">✓ ${zh ? '全通过' : 'All pass'}</span>`;
  } else {
    const parts: string[] = [`<span class="t-c-pass">${entry.doctor.passCount} ${zh ? '过' : 'P'}</span>`];
    if (entry.doctor.warnCount > 0) parts.push(`<span class="t-c-warn">${entry.doctor.warnCount} ${zh ? '警' : 'W'}</span>`);
    if (entry.doctor.failCount > 0) parts.push(`<span class="t-c-fail">${entry.doctor.failCount} ${zh ? '败' : 'F'}</span>`);
    doctorStatus = `<span class="t-chk">${parts.join('')}</span>`;
  }
  const evalTotal = entry.eval ? entry.eval.passCount + entry.eval.failCount : 0;
  const evalStatus = entry.eval
    ? `<span class="t-eval-meta"><b>${entry.eval.compositeScore != null ? entry.eval.compositeScore.toFixed(1) : '-'}</b><span class="t-eval-unit">/5</span> <span class="t-eval-sep">·</span> ${evalTotal > 0 ? `${entry.eval.passCount}/${evalTotal}` : '-'} <span class="t-eval-dim">${entry.eval.totalSamples}${zh ? '例' : ''}</span></span>`
    : `<span class="t-dash">—</span>`;

  // 整行点击直接进 skill 详情页(去掉中间弹框,更流畅)。
  return `<tr class="t-row" data-color="${h.color}" data-name="${e(entry.skillName.toLowerCase())}" onclick="location.href='${href}'" style="cursor:pointer">
    <td class="t-skill"><span class="t-name">${e(entry.skillName)}</span></td>
    <td class="t-score">${hasScore ? `<div class="t-eval"><div class="t-eval-num" style="color:${clr}"><strong>${h.score}</strong></div><div class="t-eval-bars">${mkBar(dP, zh ? '体检' : 'Doctor')}${mkBar(eP, zh ? '评测' : 'Eval')}${mkBar(oP, zh ? '观察' : 'Observe')}</div></div>` : `<span class="t-na">${zh ? '未评测' : 'N/A'}</span>`}</td>
    <td>${doctorStatus}</td>
    <td>${evalStatus}</td>
    <td class="t-reports">${reportCount || '-'}</td>
    <td class="t-time">${fmtShort(lastTs)}</td>
    <td class="t-act"><a href="${e(href)}" class="t-link">${zh ? '查看详情' : 'Details'} →</a></td>
  </tr>`;
}

const CSS = `
/* ═══ Eval Panel ═══ */
.ep{position:relative;margin-bottom:14px;background:#fff;border:1px solid rgba(79,70,229,18%);border-radius:10px;box-shadow:0 8px 28px rgba(79,70,229,8%);overflow:hidden}
.ep-grad{position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#4f46e5,#7c3aed,#06b6d4)}
.ep-top{padding:14px 16px 0}
.ep-top-left{display:flex;flex-direction:column;gap:4px}
.ep-title-row{display:flex;align-items:center;gap:10px}
.ep-brand{display:inline-block;padding:2px 8px;color:#fff;font-size:14px;font-weight:800;letter-spacing:.04em;line-height:1.4;background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:4px}
.ep-top h1{margin:0;color:#182033;font-size:18px;font-weight:700;line-height:1.3}
.ep-meta{color:#637083;font-size:12px}
.ep-strip{display:flex;align-items:stretch;gap:0;padding:10px 16px 12px}
.ep-strip-score{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex-shrink:0}
.ep-score-lbl{display:inline-flex;align-items:center;gap:3px;color:#637083;font-size:12px;font-weight:600;cursor:pointer}
.ep-score-lbl:hover{color:#4f46e5}
.ep-sep{width:1px;margin:0 14px;background:#e4e8f1;flex-shrink:0}
.ep-dims{display:flex;gap:10px;flex:1;min-width:0}
.ep-dim{flex:1;min-width:180px;padding:8px 10px;display:flex;flex-direction:column;background:#f8f9fd;border:1px solid #e4e8f1;border-radius:7px}
.ep-dim-hd{display:flex;align-items:center;gap:5px;margin-bottom:4px;color:#4f46e5}
.ep-dim-hd span{color:#182033;font-size:14px;font-weight:700}
.ep-dim-hd strong{margin-left:auto;font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1}
.ep-dim-na{color:#637083!important;font-size:12px!important;font-weight:500!important}
.ep-bar{height:6px;background:#edf0f7;border-radius:3px;overflow:hidden;margin-top:4px}
.ep-bar-fill{height:100%;border-radius:3px;transition:width .4s}
.ep-dim-chk{display:flex;flex-wrap:nowrap;gap:12px;margin-top:6px;margin-bottom:2px;align-items:center}
.ep-dim-chk span{display:inline-flex;align-items:center;gap:3px;white-space:nowrap;color:#637083;font-size:12px}
.ep-dim-chk b{color:#182033;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
.c-pass{color:#1f9d63!important}.c-pass b{color:#1f9d63!important}
.c-warn{color:#d97706!important}.c-warn b{color:#d97706!important}
.c-fail{color:#dc2626!important}.c-fail b{color:#dc2626!important}
.c-na{color:#9ca3af!important}
.ep-dim-hint{margin-top:4px;padding:3px 8px;color:#94a3b8;font-size:11px;line-height:1.4;background:rgba(100,116,139,6%);border-radius:4px}
.ep-dim-empty{margin-top:6px;padding:8px 10px;color:#637083;font-size:12px;line-height:1.5;background:rgba(100,116,139,6%);border-radius:4px}
.ep-chart{height:32px;margin-top:4px;background:#f1f5f9;border-radius:4px;display:flex;align-items:center;justify-content:center}
.ep-chart svg{display:block;width:100%;height:32px}
.ep-chart-empty{color:#9ca3af;font-size:11px}
.ep-footer{display:flex;align-items:center;gap:6px;padding:8px 20px;background:linear-gradient(135deg,rgba(99,102,241,6%) 0%,rgba(139,92,246,6%) 100%);border-top:1px solid rgba(99,102,241,12%);font-size:12px;color:#637083}

/* ═══ Help Modal ═══ */
.ep-modal-overlay{display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.45);align-items:center;justify-content:center}
.ep-modal{background:#fff;border-radius:12px;max-width:520px;width:90%;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.18)}
.ep-modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.ep-modal-head strong{font-size:16px;color:#182033}
.ep-modal-head button{background:none;border:none;font-size:18px;color:#637083;cursor:pointer;padding:4px 8px;border-radius:4px}
.ep-modal-head button:hover{background:#f8f9fd}
.ep-modal-body{color:#637083;font-size:13px;line-height:1.7}
.ep-modal-body p{margin:0 0 8px}
.ep-modal-body b{color:#182033}

/* ═══ Table Panel ═══ */
.t-panel{padding:12px 14px;background:#fff;border:1px solid #e4e8f1;border-radius:8px;box-shadow:0 8px 24px rgba(31,41,55,4%)}
.t-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.t-head-l{display:inline-flex;align-items:center;gap:8px}
.t-head h2{margin:0;color:#182033;font-size:16px;font-weight:700;line-height:1.4}
.t-head-ct{font-size:12px;font-weight:500;color:#637083}
.t-filters{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px}
.t-search{width:220px;padding:5px 10px 5px 30px;border:1px solid #e4e8f1;border-radius:6px;font-size:13px;color:#182033;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='M21 21l-4.3-4.3'/%3E%3C/svg%3E") 8px center no-repeat;outline:none;font-family:inherit}
.t-search:focus{border-color:#4f46e5;box-shadow:0 0 0 2px rgba(79,70,229,10%)}
.t-seg{display:inline-flex;padding:2px;background:#f0f1f3;border-radius:6px;gap:0}
.t-seg-btn{padding:4px 12px;font-size:12px;font-weight:400;border:none;cursor:pointer;background:transparent;color:#637083;transition:all .2s;outline:none;font-family:inherit;border-radius:4px}
.t-seg-btn:hover{color:#182033}
.t-seg-btn--on{background:#fff;color:#182033;box-shadow:0 1px 3px rgba(0,0,0,.08)}

/* ═══ Table ═══ */
.t-tbl{width:100%;border-collapse:collapse}
.t-tbl th{text-align:left;padding:10px 16px;font-size:11px;font-weight:600;color:#9ca3af;background:transparent;border-bottom:1px solid #e4e8f1;white-space:nowrap;letter-spacing:.03em;text-transform:uppercase}
.t-tbl td{text-align:left;padding:18px 16px;border-bottom:1px solid #f1f3f7;vertical-align:middle}
.t-tbl tr:last-child td{border-bottom:none}
.t-tbl tbody tr{transition:background .12s}
.t-tbl tbody tr:hover td{background:#fafbff}
.t-skill{min-width:0}
.t-name{color:#182033;text-decoration:none;font-size:14px;font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t-name:hover{color:#4f46e5}
.t-score{}
.t-eval{display:flex;align-items:center;gap:10px}
.t-eval-num{flex-shrink:0;width:30px;text-align:right}
.t-eval-num strong{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums}
.t-eval-bars{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.t-bar{height:3px;background:#eef1f6;border-radius:2px;overflow:hidden;cursor:pointer}
.t-bar-f{height:100%;border-radius:2px}
.t-na{display:inline-block;padding:2px 10px;font-size:12px;color:#9ca3af;background:#f6f8fb;border-radius:10px}
.t-chk{display:inline-flex;gap:8px;font-size:12px;font-variant-numeric:tabular-nums}
.t-chk--ok{color:#9ca3af;font-weight:500}
.t-c-pass{color:#1f9d63;font-weight:600}
.t-c-warn{color:#d97706;font-weight:600}
.t-c-fail{color:#dc2626;font-weight:600}
.t-dash{color:#cbd2dd}
.t-eval-meta{font-size:12.5px;color:#637083;font-variant-numeric:tabular-nums}
.t-eval-meta b{font-size:13px;font-weight:700;color:#182033}
.t-eval-unit{color:#9ca3af}
.t-eval-sep{color:#cbd2dd;margin:0 2px}
.t-eval-dim{color:#9ca3af}
.t-reports{font-size:13px;color:#637083;font-variant-numeric:tabular-nums}
.t-time{font-size:12px;color:#9ca3af;font-variant-numeric:tabular-nums;white-space:nowrap}
.t-act{}
.t-link{font-size:12px;color:#4f46e5;text-decoration:none;font-weight:500;transition:color .15s;opacity:0}
.t-tbl tbody tr:hover .t-link{opacity:1}
.t-link:hover{text-decoration:underline}
.t-row--hidden{display:none!important}
.t-filt-out{display:none!important}

/* ═══ Pager ═══ */
.t-pager{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:12px 14px 4px;font-size:12px;color:#637083}
.t-pg-btn{padding:4px 10px;border:1px solid #e4e8f1;border-radius:4px;background:#fff;color:#637083;cursor:pointer;font-size:12px;font-family:inherit;outline:none}
.t-pg-btn:hover{border-color:#4f46e5;color:#4f46e5}
.t-pg-btn:disabled{opacity:.4;cursor:default;border-color:#e4e8f1;color:#9ca3af}
.t-pg-info{font-variant-numeric:tabular-nums}

/* ═══ Legacy ═══ */
.t-legacy{margin-top:14px;text-align:center;font-size:11px;color:#b0b8c5}
.t-legacy a{color:#4f46e5}

/* ═══ Skill Detail Modal ═══ */
.sd-overlay{display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.45);align-items:center;justify-content:center}
.sd-modal{background:#fff;border-radius:12px;width:90%;max-width:760px;max-height:85vh;overflow:hidden;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.18);display:flex;flex-direction:column}
.sd-close{position:absolute;top:14px;right:14px;background:none;border:none;font-size:18px;color:#637083;cursor:pointer;padding:4px 8px;border-radius:4px;z-index:1}
.sd-close:hover{background:#f8f9fd;color:#182033}
.sd-body{padding:24px 24px 22px;overflow-y:auto}
.sd-header{padding-bottom:16px;margin-bottom:16px;border-bottom:1px solid #e4e8f1}
.sd-header h2{margin:0;font-size:18px;font-weight:700;color:#182033;letter-spacing:-.2px}
.sd-meta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;color:#637083;font-size:12px}
.sd-meta span{display:inline-flex;align-items:center;gap:4px}
.sd-overall{display:flex;align-items:center;justify-content:center;gap:24px;padding:20px 24px;margin-bottom:16px;background:linear-gradient(135deg,#f8faff 0%,#f4f0ff 100%);border:1px solid #e4e8f1;border-radius:12px}
.sd-overall-meta{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.sd-overall-label{color:#637083;font-size:12px;font-weight:500}
.sd-overall-grade{display:inline-flex;align-items:baseline;gap:8px;font-size:28px;font-weight:800;line-height:1}
.sd-overall-grade small{font-size:12px;font-weight:600;color:#637083}
.sd-overall-hint{color:#637083;font-size:11px}
.sd-dim{position:relative;padding:14px 16px;margin-bottom:12px;background:#fff;border:1px solid #e4e8f1;border-radius:10px}
.sd-dim:last-of-type{margin-bottom:0}
.dim-doctor{background:rgba(37,99,235,6%);border-color:rgba(37,99,235,18%)}
.dim-eval{background:rgba(124,58,237,6%);border-color:rgba(124,58,237,18%)}
.dim-observe{background:rgba(5,150,105,6%);border-color:rgba(5,150,105,18%)}
.sd-dim-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.sd-dim-title{display:flex;align-items:center;gap:8px;color:#182033;font-size:14px;font-weight:700}
.sd-dim-title svg{flex-shrink:0;box-sizing:content-box;width:16px;height:16px;padding:6px;border-radius:8px}
.dim-doctor .sd-dim-title svg{color:#2563eb;background:rgba(37,99,235,12%)}
.dim-eval .sd-dim-title svg{color:#7c3aed;background:rgba(124,58,237,12%)}
.dim-observe .sd-dim-title svg{color:#059669;background:rgba(5,150,105,12%)}
.sd-dim-title span{font-size:14px;font-weight:700;color:#182033}
.sd-dim-title small{font-size:12px;font-weight:500;color:#637083;margin-left:4px}
.sd-dim-score{font-size:24px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1}
.sd-dim-score small{font-size:12px;font-weight:500;color:#637083}
.sd-dim-na{font-size:12px;color:#637083}
.sd-dim-bar{height:6px;background:rgba(255,255,255,70%);border-radius:4px;overflow:hidden;margin-bottom:12px}
.sd-dim-bar-fill{height:100%;border-radius:4px;transition:width .4s}
.sd-dim-empty{padding:12px 14px;color:#637083;font-size:12px;line-height:1.5;background:rgba(100,116,139,6%);border-radius:6px}
.m-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.m-grid:has(> :nth-child(3):last-child){grid-template-columns:repeat(3,1fr)}
.m-cell{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#fff;border:1px solid rgba(0,0,0,4%);border-radius:8px}
.m-cell-icon{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;flex-shrink:0}
.m-cell-meta{display:flex;flex-direction:column;gap:1px;min-width:0}
.m-cell-meta span{font-size:11px;color:#637083;font-weight:500;line-height:1.2}
.m-cell-meta b{font-size:16px;font-weight:800;color:#182033;font-variant-numeric:tabular-nums;line-height:1.1}
.m-cell-meta b small{font-size:11px;font-weight:600;color:#637083;margin-left:1px}
.m-pass .m-cell-icon{background:rgba(31,157,99,14%);color:#1f9d63}
.m-warn .m-cell-icon{background:rgba(217,119,6,16%);color:#d97706}
.m-fail .m-cell-icon{background:rgba(220,38,38,14%);color:#dc2626}
.m-total .m-cell-icon{background:rgba(37,99,235,14%);color:#2563eb}
.m-eval .m-cell-icon{background:rgba(124,58,237,14%);color:#7c3aed}
.m-avg .m-cell-icon{background:rgba(99,102,241,14%);color:#6366f1}
.sd-history{margin-top:10px;padding-top:8px;border-top:1px solid #e4e8f1}
.sd-history-title{font-size:11px;font-weight:600;color:#637083;margin-bottom:6px}
.sd-history-item{display:flex;align-items:center;gap:10px;padding:4px 8px;border-radius:4px;font-size:12px;background:rgba(79,70,229,4%);font-weight:500;color:#182033}
.sd-history-date{min-width:100px;color:#637083}
.sd-history-score{font-weight:700;font-variant-numeric:tabular-nums;min-width:30px}
.sd-history-link{margin-left:auto;color:#4f46e5;font-weight:500;text-decoration:none;white-space:nowrap}
.sd-history-link:hover{text-decoration:underline}
.sd-guide{display:flex;align-items:center;gap:6px;margin-top:16px;padding:8px 12px;background:rgba(79,70,229,5%);border:1px solid rgba(79,70,229,12%);border-radius:6px;font-size:12px;color:#637083}
.sd-guide a{color:#4f46e5;font-weight:600;text-decoration:none}
.sd-guide a:hover{text-decoration:underline}
`;

export function renderSkillList(idx: SkillIndex, lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const iMap = idx.insightsBySkill;
  const a = aggregate(idx.entries, iMap, lang);
  const zh = lang === 'zh';

  if (idx.entries.length === 0) {
    return layout('OMK Studio', `<main><div class="t-panel"><div style="display:flex;align-items:center;gap:16px;padding:24px 20px"><div style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;color:#637083;background:#f8f9fd;border:1px solid #e4e8f1;border-radius:8px;font-size:24px">📋</div><div><strong style="color:#182033;font-size:14px">${zh ? '暂无 skill 报告' : 'No skill reports'}</strong><br><span style="color:#637083;font-size:12px">${zh ? '先跑一次评测：' : 'Run:'} <code style="padding:1px 6px;background:rgba(79,70,229,10%);color:#4f46e5;font-size:12px;border-radius:4px">omk eval --treatment my-skill</code></span></div></div></div></main><style>${CSS}</style>`, lang);
  }

  const rows = idx.entries.map((ent) => renderRow(ent, iMap.get(ent.skillName) ?? [], langQ, lang)).join('');

  return layout(zh ? 'OMK 评测' : 'OMK Eval', `<main>
    ${renderPanel(a, lang)}
    <div class="t-panel">
      <div class="t-head">
        <div class="t-head-l"><h2>📋 Skill ${zh ? '明细' : 'Details'}</h2><span class="t-head-ct">${a.totalSkills} skill</span></div>
        <div class="t-filters">
          <input type="text" class="t-search" id="t-search" placeholder="${zh ? '搜索 skill 名称...' : 'Search...'}" />
          <div class="t-seg">
            <button class="t-seg-btn t-seg-btn--on" data-filter="all">${zh ? '全部' : 'All'}</button>
            <button class="t-seg-btn" data-filter="red">${zh ? '异常' : 'Bad'}</button>
            <button class="t-seg-btn" data-filter="yellow">${zh ? '待改进' : 'Fair'}</button>
            <button class="t-seg-btn" data-filter="green">${zh ? '正常' : 'OK'}</button>
            <button class="t-seg-btn" data-filter="gray">${zh ? '未评估' : 'N/A'}</button>
          </div>
        </div>
      </div>
      <div style="overflow-x:auto">
      <table class="t-tbl">
        <colgroup><col style="width:200px"><col style="width:180px"><col style="width:90px"><col style="width:130px"><col style="width:50px"><col style="width:100px"><col style="width:80px"></colgroup>
        <thead><tr><th>Skill</th><th>${zh ? '综合分' : 'Score'}</th><th>Doctor</th><th>Eval</th><th>${zh ? '报告数' : 'Runs'}</th><th>${zh ? '更新时间' : 'Updated'}</th><th>${zh ? '操作' : ''}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
      <div class="t-pager" id="t-pager"></div>
    </div>
    <div class="t-legacy">${zh ? '找老的 run 列表？' : 'Old run list?'} <a href="/runs${langQ}">/runs</a></div>
  </main><style>${CSS}</style>
  <script>!function(){
    var PS=10,pg=1,bs=document.querySelectorAll('.t-seg-btn'),s=document.getElementById('t-search'),pgr=document.getElementById('t-pager');
    function vis(){return Array.from(document.querySelectorAll('.t-row')).filter(function(r){return !r.classList.contains('t-filt-out')})}
    function filt(){
      var a=document.querySelector('.t-seg-btn--on'),fl=a?a.getAttribute('data-filter'):'all',q=(s?s.value:'').toLowerCase();
      document.querySelectorAll('.t-row').forEach(function(r){r.classList.toggle('t-filt-out',!(( fl==='all'||r.getAttribute('data-color')===fl)&&(!q||(r.getAttribute('data-name')||'').indexOf(q)!==-1)))});
      pg=1;page()
    }
    function page(){
      var rs=vis(),t=rs.length,pp=Math.max(1,Math.ceil(t/PS));if(pg>pp)pg=pp;
      var st=(pg-1)*PS,en=st+PS;
      rs.forEach(function(r,i){r.classList.toggle('t-row--hidden',i<st||i>=en)});
      if(pgr)pgr.innerHTML=t<=PS?'':\`<span class="t-pg-info">\${st+1}-\${Math.min(en,t)} / \${t}</span><button class="t-pg-btn" onclick="window.__pg(-1)" \${pg<=1?'disabled':''}>‹ 上一页</button><button class="t-pg-btn" onclick="window.__pg(1)" \${pg>=pp?'disabled':''}>下一页 ›</button>\`
    }
    window.__pg=function(d){pg+=d;page()};
    bs.forEach(function(b){b.addEventListener('click',function(){bs.forEach(function(x){x.classList.remove('t-seg-btn--on')});b.classList.add('t-seg-btn--on');filt()})});
    if(s)s.addEventListener('input',filt);page()
  }()</script>`, lang);
}
