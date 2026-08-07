/**
 * Skill 列表页 — 仪表盘布局，精确参照内部 SkillHealth dashboard。
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import { assessHealth } from './skill-detail-renderer.js';
import { icon } from './icons.js';
import type { Lang, SkillIndex, SkillIndexEntry, Insight } from '../types/index.js';

// ── icons (Lucide SVG inline) ── 维度/状态图标统一走共享 icons.ts;此处仅保留弹框用的 help 图标。
const IC = {
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
// 综合健康配色:≥85 绿 / ≥60 琥珀 / 其余红。与 report-shell.healthColor 同口径,
// 保证同一个分数在首页列表与报告页 Hero 颜色一致(90 两处都是绿,不再首页橙、详情红)。
function scoreColor(s: number): string { return s >= 85 ? '#1f9d63' : s >= 60 ? '#d97706' : '#dc2626'; }

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

function ring(score: number | null, size: number, sw: number): string {
  const r = (size - sw) / 2, c = 2 * Math.PI * r, off = c * (1 - (score ?? 0) / 100), clr = score != null ? scoreColor(score) : '#9ca3af', cx = size / 2;
  return `<div style="position:relative;width:${size}px;height:${size}px"><svg width="${size}" height="${size}"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#edf0f7" stroke-width="${sw}"/>${score != null ? `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${clr}" stroke-width="${sw}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cx})" style="transition:stroke-dashoffset .6s"/>` : ''}</svg><div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center"><span style="font-size:${Math.round(size * 0.36)}px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;color:${clr}">${score ?? '—'}</span></div></div>`;
}

function renderPanel(a: Agg, lang: Lang): string {
  const zh = lang === 'zh';
  const dTotal = a.dP + a.dW + a.dF;
  const dScore = dTotal > 0 ? Math.round(((a.dP + a.dW * 0.5) / dTotal) * 100) : null;

  // 页头(品牌已在常驻顶栏,这里不再重复 brand badge)。
  const phead = `<div class="phead">
    <h1>${zh ? 'Skill 健康评测工作台' : 'Skill Health Dashboard'}</h1>
    <span class="phead-sub">${a.totalSkills} ${zh ? '个 skill' : 'skills'}</span>
    <span class="phead-when">${icon('clock', { size: 13 })} ${zh ? '更新于' : 'updated'} ${fmtDate(a.lastTs)}</span>
    <a href="/${zh ? '' : '?lang=en'}" style="margin-left:auto;font-size:13px;color:var(--accent);text-decoration:none;white-space:nowrap">${zh ? '对话总览' : 'Conversation overview'} →</a>
    <a href="/managed${zh ? '' : '?lang=en'}" style="font-size:13px;color:var(--accent);text-decoration:none;white-space:nowrap">${zh ? '受管决策史' : 'Managed history'} →</a>
  </div>`;

  // 综合健康(细线总览首格):ring + 标签 + 说明入口。
  const ovMain = `<div class="ov-cell ov-main">
    ${ring(a.composite, 60, 6)}
    <div class="ov-main-lbl"><b>${zh ? '综合健康' : 'Overall health'}<span class="ov-help" onclick="document.getElementById('ep-help-modal').style.display='flex'">${IC.helpCircle}</span></b><span>${zh ? '加权 体检 / 评测 / 观察' : 'Weighted doctor / eval / observe'}</span></div>
  </div>`;

  const doctorCell = `<div class="ov-cell">
    <div class="ov-top">${icon('doctor', { size: 15, cls: 'ov-ico' })}<span>${zh ? '健康体检' : 'Doctor'}</span></div>
    ${dScore != null
      ? `<div class="ov-big" style="color:${scoreColor(dScore)}">${dScore}<small> / 100</small></div>
         <div class="ov-meta"><span class="c-pass">${zh ? '通过' : 'Pass'} <i>${a.dP}</i></span><span class="c-warn">${zh ? '警告' : 'Warn'} <i>${a.dW}</i></span><span class="c-fail">${zh ? '失败' : 'Fail'} <i>${a.dF}</i></span></div>`
      : `<div class="ov-big ov-empty-v">${zh ? '未运行' : 'Not run'}</div>`}
  </div>`;

  const evalCell = `<div class="ov-cell">
    <div class="ov-top">${icon('eval', { size: 15, cls: 'ov-ico' })}<span>${zh ? '用例评测' : 'Eval'}</span></div>
    ${a.eAvg != null
      ? `<div class="ov-big" style="color:${scoreColor(Math.round((a.eAvg / 5) * 100))}">${a.eAvg.toFixed(1)}<small> / 5</small></div>
         <div class="ov-meta"><span>${zh ? '断言' : 'Assert'} <i>${a.eAssertP}/${a.eAssertT}</i></span><span>${zh ? '用例' : 'Samples'} <i>${a.eSamples}</i></span></div>`
      : `<div class="ov-big ov-empty-v">${zh ? '未运行' : 'Not run'}</div>`}
  </div>`;

  const obsCell = `<div class="ov-cell">
    <div class="ov-top">${icon('observe', { size: 15, cls: 'ov-ico' })}<span>${zh ? '生产观察' : 'Observe'}</span></div>
    ${a.withObs > 0
      ? `<div class="ov-big">${a.withObs}<small> skill</small></div><div class="ov-meta ov-meta--muted">${zh ? '个 skill 有线上数据' : 'with traces'}</div>`
      : `<div class="ov-big ov-empty-v">${zh ? '暂无数据' : 'No data'}</div><div class="ov-meta ov-meta--muted">${zh ? '接入线上调用后自动采集' : 'Auto-collected once invoked'}</div>`}
  </div>`;

  return `${phead}<div class="ov">${ovMain}${doctorCell}${evalCell}${obsCell}</div>

<div id="ep-help-modal" class="ep-modal-overlay" onclick="if(event.target===this)this.style.display='none'">
  <div class="ep-modal">
    <div class="ep-modal-head"><strong>${zh ? '综合健康计算说明' : 'Health Score'}</strong><button onclick="document.getElementById('ep-help-modal').style.display='none'">✕</button></div>
    <div class="ep-modal-body">
      <p><b>${zh ? '综合健康' : 'Overall Health'}</b> = ${zh ? '已评分 skill 综合分的算术平均（未跑任何可信维度的 skill 不计入）' : 'Arithmetic mean of scored skills’ composites (skills with no trusted dimension are excluded)'}。</p>
      <p>${zh ? '单 skill 综合分 = 已运行维度各自归一到 0-100 后取算术平均：健康体检 =（通过 + 0.5×警告）/ 规则数；用例评测 = 综合分 / 5；生产观察 = 覆盖率 × 色带系数（黄 0.85 / 红 0.6），样本量不足时不计入。' : 'Per-skill composite = arithmetic mean of the dimensions that ran, each normalized to 0-100: doctor = (pass + 0.5×warn) / rules; eval = composite / 5; observe = coverage × band factor (yellow 0.85 / red 0.6), skipped when underpowered.'}</p>
      <p>${zh ? '下方三格分别为：体检按规则数合并的通过率、评测为各 skill 综合分的平均、观察为有线上数据的 skill 数。' : 'The three cells below: doctor pools rule counts, eval averages per-skill composites, observe counts skills with traces.'}</p>
      <p>${zh ? '分数配色：≥85 绿 / 60-84 琥珀 / <60 红。' : 'Score colors: ≥85 green / 60-84 amber / <60 red.'}</p>
    </div>
  </div>
</div>`;
}

// renderSkillModal 已移除:首页点行直接进 skill 详情页(doctor/eval/observe 已在该页合一),弹框预览冗余。

function renderRow(entry: SkillIndexEntry, insights: Insight[], langQ: string, lang: Lang): string {
  const h = assessHealth(entry, insights, lang);
  // 点行先进入 skill hub：Skill Map / 三阶段状态 / 图谱摘要是用户第一视角。
  const href = `/skills/${encodeURIComponent(entry.skillName)}${langQ}`;
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
  // 跳转地址走 data-href + 底部脚本的事件委托,不内联 onclick:skill 名含引号时
  // encodeURIComponent 不会编码单引号,裸拼进 onclick 字符串会变成 JS 注入面。
  return `<tr class="t-row" data-color="${h.color}" data-name="${e(entry.skillName.toLowerCase())}" data-href="${e(href)}" style="cursor:pointer">
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
/* ═══ 总览(细线 4 格,低饱和) ═══ */
.phead{display:flex;align-items:baseline;gap:12px;margin-bottom:18px}
.phead h1{font-size:20px;font-weight:700;margin:0;color:var(--text-primary);letter-spacing:-.01em}
.phead-sub{color:var(--text-muted);font-size:13px}
.phead-when{margin-left:auto;color:var(--text-muted);font-size:12.5px;display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.phead-when svg{color:var(--text-faint)}
.ov{display:grid;grid-template-columns:220px 1fr 1fr 1fr;gap:1px;background:var(--border);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:22px;box-shadow:0 8px 24px rgba(31,41,55,4%)}
.ov-cell{background:#fff;padding:18px 20px}
.ov-main{display:flex;align-items:center;gap:16px}
.ov-main-lbl b{display:flex;align-items:center;gap:5px;font-size:13.5px;color:var(--text-primary);font-weight:600;margin-bottom:3px}
.ov-main-lbl span{font-size:12px;color:var(--text-secondary)}
.ov-help{display:inline-flex;color:var(--text-faint);cursor:pointer}
.ov-help:hover{color:var(--accent)}
.ov-top{display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:12.5px;font-weight:500;margin-bottom:12px}
.ov-ico{color:var(--text-muted)}
.ov-big{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1;color:var(--text-primary);font-variant-numeric:tabular-nums}
.ov-big small{font-size:13px;color:var(--text-muted);font-weight:500}
.ov-empty-v{font-size:14px;color:var(--text-muted);font-weight:500}
.ov-meta{margin-top:10px;display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--text-secondary)}
.ov-meta i{font-style:normal;font-weight:600;font-variant-numeric:tabular-nums}
.ov-meta--muted{color:var(--text-muted)}
.c-pass{color:#1f9d63!important}.c-warn{color:#d97706!important}.c-fail{color:#dc2626!important}.c-na{color:#9ca3af!important}
@media(max-width:860px){.ov{grid-template-columns:1fr 1fr}.ov-main{grid-column:1 / -1}}
@media(max-width:560px){.ov{grid-template-columns:1fr}.ov-main{grid-column:auto}}

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
    return layout('OMK Studio', `<main><div class="t-panel"><div style="display:flex;align-items:center;gap:16px;padding:24px 20px"><div style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;color:#637083;background:#f8f9fd;border:1px solid #e4e8f1;border-radius:8px">${icon('eval', { size: 24 })}</div><div><strong style="color:#182033;font-size:14px">${zh ? '暂无 skill 报告' : 'No skill reports'}</strong><br><span style="color:#637083;font-size:12px">${zh ? '先跑一次评测：' : 'Run:'} <code style="padding:1px 6px;background:rgba(79,70,229,10%);color:#4f46e5;font-size:12px;border-radius:4px">omk eval --treatment my-skill</code></span></div></div></div></main><style>${CSS}</style>`, lang);
  }

  const rows = idx.entries.map((ent) => renderRow(ent, iMap.get(ent.skillName) ?? [], langQ, lang)).join('');

  return layout(zh ? 'OMK 评测' : 'OMK Eval', `<main>
    ${renderPanel(a, lang)}
    <div class="t-panel">
      <div class="t-head">
        <div class="t-head-l"><h2>${zh ? '明细' : 'Details'}</h2><span class="t-head-ct">${a.totalSkills} skill</span></div>
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
      if(pgr)pgr.innerHTML=t<=PS?'':\`<span class="t-pg-info">\${st+1}-\${Math.min(en,t)} / \${t}</span><button class="t-pg-btn" onclick="window.__pg(-1)" \${pg<=1?'disabled':''}>‹ ${zh ? '上一页' : 'Prev'}</button><button class="t-pg-btn" onclick="window.__pg(1)" \${pg>=pp?'disabled':''}>${zh ? '下一页' : 'Next'} ›</button>\`
    }
    window.__pg=function(d){pg+=d;page()};
    bs.forEach(function(b){b.addEventListener('click',function(){bs.forEach(function(x){x.classList.remove('t-seg-btn--on')});b.classList.add('t-seg-btn--on');filt()})});
    document.addEventListener('click',function(ev){var el=ev.target instanceof Element?ev.target:null;if(!el||el.closest('a,button'))return;var r=el.closest('.t-row[data-href]');if(r)location.href=r.getAttribute('data-href')});
    if(s)s.addEventListener('input',filt);page()
  }()</script>`, lang);
}
