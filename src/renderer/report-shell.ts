/**
 * 报告详情页统一外壳（doctor / eval / observe 共用）。
 *
 * 设计原则（与首页 / skill 弹框 aima 风格统一）：
 *   - 纯白卡片 + 冷灰边框 #e4e8f1 + 柔和阴影
 *   - 综合分用 score ring，色阶 100 绿 / ≥60 橙 / <60 红
 *   - 维度色：doctor 蓝 #2563eb / eval 紫 #7c3aed / observe 绿 #059669
 *   - 主次分明：Hero 综合结论在最上，明细按 fail→warn→pass 排序，通过项折叠
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import type { Lang } from '../types/index.js';

export const DIM_COLORS = {
  doctor: '#2563eb',
  eval: '#7c3aed',
  observe: '#059669',
} as const;

export function scoreColor(s: number): string {
  return s >= 100 ? '#1f9d63' : s >= 60 ? '#d97706' : '#dc2626';
}

/** band → 十六进制色(绿/黄/红/灰)。供 hero 综合健康 ring、chip 状态点等复用。 */
export function bandHex(band: 'green' | 'yellow' | 'red' | 'gray'): string {
  return band === 'green' ? '#1f9d63' : band === 'yellow' ? '#d97706' : band === 'red' ? '#dc2626' : '#9ca3af';
}

/** 综合分 score ring（数字叠在圆环中心）。
 *  score = 0-100,只决定**弧度填充比例**;centerText 覆盖圆心显示文字(如 eval 显原生 "4.09" 而非 82);
 *  color 覆盖弧/数字颜色(让 eval 按 /5 色档着色,而不是 0-100 阈值)。 */
export function scoreRing(score: number | null, size = 88, sw = 8, centerText?: string, color?: string): string {
  const r = (size - sw) / 2, c = 2 * Math.PI * r;
  const pct = score ?? 0, off = c * (1 - pct / 100);
  const clr = color ?? (score != null ? scoreColor(score) : '#9ca3af');
  const display = centerText ?? (score != null ? String(score) : '—');
  const cx = size / 2;
  return `<div class="rs-ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}">
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#edf0f7" stroke-width="${sw}"/>
      ${score != null ? `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${clr}" stroke-width="${sw}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cx})"/>` : ''}
    </svg>
    <div class="rs-ring-inner"><span style="color:${clr}">${e(display)}</span></div>
  </div>`;
}

/** 一个维度 chip（doctor / eval / observe）。score 0-100,null=无分;href=null 表示当前页或无数据。 */
export interface SkillReportContextChip {
  dim: keyof typeof DIM_COLORS;
  label: string;
  score: number | null;
  band: 'green' | 'yellow' | 'red' | 'gray';
  href: string | null;
  active: boolean;
}

/** 「全部历史」弹框里的一条历史记录(doctor / eval 的某一次 run)。 */
export interface SkillReportHistoryItem {
  dim: keyof typeof DIM_COLORS;
  dateText: string;
  scoreText: string;
  /** 分数色档,用于一眼扫出哪次回归。 */
  band: 'green' | 'yellow' | 'red' | 'gray';
  metaText: string;
  href: string;
  current: boolean;
}

/** 报告页顶部的「skill 上下文」：三个维度互链 + 「全部历史」弹框。让同一 skill 的报告跨维度/跨轮次都能一跳到达。 */
export interface SkillReportContext {
  /** 规范 skill 名(来自 skill-index entry)— 各报告页头部统一用它,避免 eval/doctor 名字不一致。 */
  skillName: string;
  /** 综合健康分(跨维度聚合,与首页列表同口径)。报告页只显单维度,这里把「总分」也带上。 */
  overall: { score: number | null; band: 'green' | 'yellow' | 'red' | 'gray' };
  chips: SkillReportContextChip[];
  /** 该 skill 的 doctor + eval 历次报告,供「全部历史」弹框选择。 */
  history: SkillReportHistoryItem[];
}

// 维度身份用 DIM_COLORS 着色的小圆点(doctor 蓝 / eval 紫 / observe 绿),分数用 band 色。
// 维度切换器 = 分段控件风:当前维度填充高亮,其余可点跳到兄弟报告。右侧「全部历史」按钮弹框选历次 run。
function renderSkillContext(ctx: SkillReportContext, lang: Lang): string {
  const zh = lang === 'zh';
  // tab 上不放分数 —— 只一个状态点(band 色)+ 维度名,点击直接看该维度明细。综合总分在 Hero。
  const chipHtml = ctx.chips.map((c) => {
    const dot = `<span class="rs-dim-dot" style="background:${c.band === 'gray' ? '#cbd2dd' : bandHex(c.band)}"></span>`;
    const inner = `${dot}<span class="rs-dim-lbl">${e(c.label)}</span>`;
    if (c.active) return `<span class="rs-dim rs-dim--active" aria-current="page">${inner}</span>`;
    if (c.href) return `<a class="rs-dim" href="${e(c.href)}">${inner}</a>`;
    return `<span class="rs-dim rs-dim--empty">${inner}</span>`;
  }).join('');

  const histBtn = ctx.history.length > 0
    ? `<button type="button" class="rs-hist-btn" onclick="document.getElementById('rs-hist').style.display='flex'">${zh ? '全部历史' : 'All history'} <span class="rs-hist-ct">${ctx.history.length}</span></button>`
    : '';
  const bar = `<div class="rs-dims"><span class="rs-dims-seg">${chipHtml}</span>${histBtn}</div>`;

  if (ctx.history.length === 0) return bar;

  const dimLabel = (dim: keyof typeof DIM_COLORS): string =>
    dim === 'doctor' ? (zh ? '体检' : 'Doctor') : dim === 'eval' ? (zh ? '评测' : 'Eval') : (zh ? '观察' : 'Observe');
  const groups = (['eval', 'doctor'] as const).map((dim) => {
    const items = ctx.history.filter((h) => h.dim === dim);
    if (items.length === 0) return '';
    const rows = items.map((h) => `<a class="rs-hist-row${h.current ? ' rs-hist-row--cur' : ''}" href="${e(h.href)}">
      <span class="rs-hist-date">${e(h.dateText)}</span>
      <span class="rs-hist-score rs-hist-score--${h.band}">${e(h.scoreText)}</span>
      <span class="rs-hist-meta">${e(h.metaText)}</span>
      <span class="rs-hist-go">${h.current ? (zh ? '当前' : 'current') : '→'}</span>
    </a>`).join('');
    return `<div class="rs-hist-group"><div class="rs-hist-group-h"><span class="rs-hist-group-dot" style="background:${DIM_COLORS[dim]}"></span>${e(dimLabel(dim))} <small>${items.length}</small></div>${rows}</div>`;
  }).join('');

  const modal = `<div id="rs-hist" class="rs-hist-overlay" onclick="if(event.target===this)this.style.display='none'">
    <div class="rs-hist-modal">
      <div class="rs-hist-head"><strong>${e(ctx.skillName)} · ${zh ? '全部历史' : 'All history'}</strong><button type="button" class="rs-hist-x" onclick="document.getElementById('rs-hist').style.display='none'">✕</button></div>
      <div class="rs-hist-list">${groups}</div>
    </div>
  </div>`;

  return bar + modal;
}

export interface ReportShellOpts {
  /** 维度：决定强调色。 */
  dim: keyof typeof DIM_COLORS;
  /** emoji 图标。 */
  icon: string;
  /** 报告类型标题，如「健康体检报告」。 */
  kindTitle: string;
  /** skill 名称。 */
  skillName: string;
  /** 副信息行（时间戳 / reportId 等）。 */
  metaItems: string[];
  /** 弧度填充用的 0-100 比例,null = 不显示 ring。 */
  score: number | null;
  /** 圆心显示文字。不传则显 score。eval 用它显原生 "4.09",doctor 显 "75"。 */
  scoreText?: string;
  /** 弧/数字/等级文字颜色覆盖。eval 按 /5 色档,不传则按 0-100 阈值。 */
  ringColor?: string;
  /** 综合分下方的文字（如「综合分 / 5」「健康分 / 100」）。 */
  scoreLabel?: string;
  /** 返回链接。 */
  backHref: string;
  backLabel: string;
  /** 内容区 HTML。 */
  body: string;
  /** skill 上下文 chip 条(可选)— doctor/eval/observe 互链 + 回 hub。 */
  skillContext?: SkillReportContext;
  /** 额外 CSS。 */
  extraCss?: string;
}

export function reportShell(opts: ReportShellOpts, lang: Lang = DEFAULT_LANG): string {
  const accent = DIM_COLORS[opts.dim];
  const clr = opts.ringColor ?? (opts.score != null ? scoreColor(opts.score) : '#9ca3af');
  const hero = `<div class="rs-hero rs-hero--${opts.dim}">
    <div class="rs-hero-left">
      <div class="rs-hero-kind"><span class="rs-hero-icon" style="color:${accent}">${opts.icon}</span> ${e(opts.kindTitle)}</div>
      <h1 class="rs-hero-name">${e(opts.skillName)}</h1>
      <div class="rs-hero-meta">${opts.metaItems.map((m) => `<span>${m}</span>`).join('')}</div>
    </div>
    ${opts.score != null ? `<div class="rs-hero-score">
      ${scoreRing(opts.score, 88, 8, opts.scoreText, opts.ringColor)}
      ${opts.scoreLabel ? `<div class="rs-hero-grade" style="color:${clr}">${e(opts.scoreLabel)}</div>` : ''}
    </div>` : ''}
  </div>`;

  return layout(`${opts.kindTitle} · ${opts.skillName}`, `
    <main>
      <a class="rs-back" href="${e(opts.backHref)}">← ${e(opts.backLabel)}</a>
      ${hero}
      ${opts.skillContext ? renderSkillContext(opts.skillContext, lang) : ''}
      ${opts.body}
    </main>
    <style>${REPORT_SHELL_CSS}${opts.extraCss ?? ''}</style>
  `, lang);
}

export const REPORT_SHELL_CSS = `
.rs-back{display:inline-block;margin-bottom:12px;color:#9ca3af;font-size:13px;text-decoration:none}
.rs-back:hover{color:#4f46e5}

/* ── skill 维度切换器(doctor/eval/observe 互链)— 分段控件风 ── */
.rs-dims{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 16px}
.rs-dims-seg{display:inline-flex;align-items:stretch;background:#fff;border:1px solid #e4e8f1;border-radius:10px;padding:3px;gap:2px;box-shadow:0 1px 2px rgba(31,41,55,3%)}
.rs-dim{display:inline-flex;align-items:center;gap:7px;font-size:13px;padding:7px 14px;border-radius:7px;color:#637083;text-decoration:none;white-space:nowrap;transition:background .12s,color .12s}
a.rs-dim:hover{background:#f1f4f9;color:#182033}
.rs-dim-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.rs-dim-lbl{font-weight:500}
/* 当前维度:浅填充 + 状态点已表明身份,文字加重 */
.rs-dim--active{background:#f1f4f9;color:#182033;cursor:default}
.rs-dim--active .rs-dim-lbl{font-weight:700}
.rs-dim--empty{color:#b6bcc8;cursor:default}
/* 全部历史按钮 */
.rs-hist-btn{display:inline-flex;align-items:center;gap:6px;font-size:13px;padding:7px 13px;border-radius:9px;border:1px solid #e4e8f1;background:#fff;color:#637083;cursor:pointer;white-space:nowrap;font-family:inherit;transition:border-color .15s,color .15s}
.rs-hist-btn:hover{border-color:#c7cedb;color:#182033}
.rs-hist-ct{font-variant-numeric:tabular-nums;font-weight:700;color:#9ca3af;font-size:12px}
/* 全部历史弹框 */
.rs-hist-overlay{display:none;position:fixed;inset:0;background:rgba(24,32,51,.32);z-index:50;align-items:flex-start;justify-content:center;padding:8vh 16px}
.rs-hist-modal{background:#fff;border-radius:14px;box-shadow:0 24px 60px rgba(31,41,55,.22);width:100%;max-width:520px;max-height:76vh;display:flex;flex-direction:column;overflow:hidden}
.rs-hist-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #eef1f6;font-size:14px;color:#182033}
.rs-hist-x{background:transparent;border:none;color:#9ca3af;font-size:16px;cursor:pointer;line-height:1;padding:4px}
.rs-hist-x:hover{color:#182033}
.rs-hist-list{overflow-y:auto;padding:6px 10px 12px}
.rs-hist-group{margin-top:8px}
.rs-hist-group-h{display:flex;align-items:center;gap:7px;font-size:12px;color:#637083;font-weight:600;padding:8px 8px 6px}
.rs-hist-group-dot{width:7px;height:7px;border-radius:50%}
.rs-hist-group-h small{font-weight:500;color:#b6bcc8}
.rs-hist-row{display:flex;align-items:baseline;gap:14px;padding:8px;border-radius:8px;text-decoration:none;color:#182033;font-size:13px}
.rs-hist-row:hover{background:#f1f4f9}
.rs-hist-row--cur{background:#f1f4f9;cursor:default}
.rs-hist-date{font-variant-numeric:tabular-nums;color:#637083;min-width:88px;flex-shrink:0}
.rs-hist-score{font-weight:700;font-variant-numeric:tabular-nums;font-family:"SF Mono",Menlo,monospace;min-width:72px;flex-shrink:0}
.rs-hist-score--green{color:#1f9d63}.rs-hist-score--yellow{color:#d97706}.rs-hist-score--red{color:#dc2626}.rs-hist-score--gray{color:#9ca3af}
.rs-hist-meta{flex:1;min-width:0;color:#9ca3af;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rs-hist-go{color:#c0c6d2;font-size:13px;flex-shrink:0}
.rs-hist-row:hover .rs-hist-go{color:#637083}
.rs-hist-row--cur .rs-hist-go{color:#4f46e5;font-weight:600;font-size:12px}

/* ── Hero ── */
.rs-hero{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px 24px;background:#fff;border:1px solid #e4e8f1;border-radius:12px;box-shadow:0 8px 24px rgba(31,41,55,4%);margin-bottom:16px}
@media(max-width:640px){.rs-hero{flex-direction:column;align-items:flex-start}}
.rs-hero-left{display:flex;flex-direction:column;gap:4px;min-width:0}
.rs-hero-kind{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#637083}
.rs-hero-icon{font-size:14px}
.rs-hero-name{margin:0;font-size:20px;font-weight:700;color:#182033;letter-spacing:-.2px}
.rs-hero-meta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px;color:#9ca3af;font-size:12px;font-variant-numeric:tabular-nums}
.rs-hero-meta span{display:inline-flex;align-items:center;gap:4px}
.rs-hero-score{display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0}
.rs-hero-grade{font-size:13px;font-weight:700}

/* ── Score ring ── */
.rs-ring{position:relative}
.rs-ring-inner{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.rs-ring-inner span{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1}

/* ── 统计条 ── */
.rs-stats{display:flex;flex-wrap:wrap;gap:20px;padding:14px 20px;background:#fff;border:1px solid #e4e8f1;border-radius:10px;box-shadow:0 8px 24px rgba(31,41,55,4%);margin-bottom:16px}
.rs-stat{display:flex;align-items:baseline;gap:6px}
.rs-stat-num{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1}
.rs-stat-label{font-size:12px;color:#637083}
.rs-stat--pass .rs-stat-num{color:#1f9d63}
.rs-stat--warn .rs-stat-num{color:#d97706}
.rs-stat--fail .rs-stat-num{color:#dc2626}
.rs-stat--total .rs-stat-num{color:#182033}

/* ── Panel（内容区块） ── */
.rs-panel{background:#fff;border:1px solid #e4e8f1;border-radius:12px;box-shadow:0 8px 24px rgba(31,41,55,4%);padding:18px 20px;margin-bottom:16px}
.rs-panel-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:#182033;margin-bottom:14px}
.rs-panel-title small{font-size:12px;font-weight:400;color:#9ca3af;margin-left:4px}

/* ── 规则 / 用例卡片 ── */
.rs-card{border:1px solid #e4e8f1;border-radius:10px;margin-bottom:10px;overflow:hidden}
.rs-card:last-child{margin-bottom:0}
.rs-card--fail{border-color:rgba(220,38,38,25%);background:rgba(220,38,38,3%)}
.rs-card--warn{border-color:rgba(217,119,6,25%);background:rgba(217,119,6,3%)}
.rs-card--pass{border-color:#e4e8f1}
.rs-card-head{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;list-style:none}
.rs-card-head::-webkit-details-marker{display:none}
.rs-card-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.rs-card-dot--fail{background:#dc2626}
.rs-card-dot--warn{background:#d97706}
.rs-card-dot--pass{background:#1f9d63}
.rs-card-dot--skip{background:#cbd2dd}
.rs-card-name{flex:1;min-width:0;font-size:14px;font-weight:600;color:#182033;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rs-card-badges{display:flex;gap:6px;flex-shrink:0}
.rs-badge{font-size:11px;font-weight:600;padding:1px 8px;border-radius:10px}
.rs-badge--fail{color:#dc2626;background:rgba(220,38,38,10%)}
.rs-badge--warn{color:#d97706;background:rgba(217,119,6,10%)}
.rs-badge--pass{color:#1f9d63;background:rgba(31,157,99,10%)}
.rs-card-body{padding:0 14px 12px;border-top:1px solid rgba(0,0,0,4%)}
.rs-finding{padding:10px 12px;margin-top:10px;border-radius:8px;font-size:13px;line-height:1.6}
.rs-finding--err{background:rgba(220,38,38,5%);border-left:2px solid #dc2626}
.rs-finding--warn{background:rgba(217,119,6,5%);border-left:2px solid #d97706}
.rs-finding-desc{color:#182033;word-break:break-word}
.rs-finding-sug{margin-top:6px;padding:6px 10px;background:rgba(79,70,229,5%);border-radius:6px;color:#4f46e5;font-size:12.5px;word-break:break-word}

/* ── 折叠通过项 ── */
.rs-fold{margin-top:10px}
.rs-fold>summary{cursor:pointer;list-style:none;font-size:12.5px;color:#637083;padding:6px 0}
.rs-fold>summary::-webkit-details-marker{display:none}
.rs-fold>summary:hover{color:#182033}
.rs-fold[open]>summary{margin-bottom:8px}

/* ── 空态 ── */
.rs-empty{padding:32px 20px;text-align:center;color:#9ca3af;font-size:13px}
`;
