import { DEFAULT_LANG, e, layout } from './layout.js';
import { assessHealth } from './skill-detail-renderer.js';
import type { Lang, SkillIndex } from '../types/index.js';

function dateText(timestamp: string | null): string {
  if (timestamp === null) return '—';
  try {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return timestamp;
  }
}

export function renderSkillList(index: SkillIndex, lang: Lang = DEFAULT_LANG): string {
  const zh = lang === 'zh';
  const langQ = zh ? '' : '?lang=en';
  const rows = index.entries.map((entry) => {
    const insights = index.insightsBySkill.get(entry.skillName) ?? [];
    const health = assessHealth(entry, insights, lang);
    const doctor = entry.doctor;
    const doctorText = doctor === null
      ? '—'
      : `${doctor.passCount}✓ ${doctor.warnCount}⚠ ${doctor.failCount}✗`;
    const observe = entry.observe;
    const observeText = observe === null
      ? '—'
      : observe.confidence === 'underpowered'
        ? (zh ? '样本不足' : 'underpowered')
        : `${(observe.gapRate * 100).toFixed(1)}% ${zh ? '缺口' : 'gap'}`;
    const updatedAt = [doctor?.timestamp, observe?.generatedAt].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    return `<tr data-band="${health.color}"><td><a href="/skills/${encodeURIComponent(entry.skillName)}${langQ}">${e(entry.skillName)}</a></td><td><span class="sl-band sl-band--${health.color}">${e(health.label)}</span>${health.score === null ? '' : ` <strong>${health.score}</strong>`}</td><td>${e(doctorText)}</td><td>${e(observeText)}</td><td>${insights.length}</td><td>${e(dateText(updatedAt))}</td></tr>`;
  }).join('');
  return layout(zh ? '知识健康工作台' : 'Knowledge health', `<main class="sl-main"><header><div><p>Observe. Measure. Know.</p><h1>${zh ? '知识健康工作台' : 'Knowledge health'}</h1></div><a href="/${langQ}">${zh ? '对话总览' : 'Conversations'} →</a></header><section class="sl-summary"><span>${index.summary.totalSkills} ${zh ? '个知识对象' : 'knowledge artifacts'}</span><span class="sl-red">${index.summary.red} ${zh ? '红' : 'red'}</span><span class="sl-yellow">${index.summary.yellow} ${zh ? '黄' : 'yellow'}</span><span class="sl-green">${index.summary.green} ${zh ? '绿' : 'green'}</span></section><section class="sl-card"><table><thead><tr><th>Skill</th><th>${zh ? '健康' : 'Health'}</th><th>Doctor</th><th>Observe</th><th>${zh ? '问题' : 'Findings'}</th><th>${zh ? '更新时间' : 'Updated'}</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="sl-empty">${zh ? '尚无 doctor 或 observe 数据。' : 'No doctor or observe data yet.'}</td></tr>`}</tbody></table></section></main><style>${CSS}</style>`, lang);
}

const CSS = `
.sl-main{max-width:1100px;margin:0 auto;padding:24px}.sl-main header{display:flex;align-items:end;justify-content:space-between;margin-bottom:18px}.sl-main header p{margin:0;color:var(--text-muted);font-size:12px}.sl-main h1{margin:5px 0 0;font-size:24px}.sl-main header a{color:var(--accent);text-decoration:none}.sl-summary{display:flex;gap:18px;padding:14px 18px;background:#fff;border:1px solid var(--border);border-radius:10px;margin-bottom:14px}.sl-red{color:#dc2626}.sl-yellow{color:#d97706}.sl-green{color:#1f9d63}.sl-card{overflow:auto;background:#fff;border:1px solid var(--border);border-radius:10px}.sl-card table{width:100%;border-collapse:collapse}.sl-card th,.sl-card td{padding:13px 16px;text-align:left;border-bottom:1px solid #eef1f6;white-space:nowrap}.sl-card th{font-size:11px;color:var(--text-muted);text-transform:uppercase}.sl-card td{font-size:13px}.sl-card td:first-child a{font-weight:650;color:var(--text-primary);text-decoration:none}.sl-band{display:inline-block;border-radius:10px;padding:2px 8px;background:#f1f3f6;color:#637083}.sl-band--red{background:#fef2f2;color:#dc2626}.sl-band--yellow{background:#fff7ed;color:#d97706}.sl-band--green{background:#ecfdf5;color:#1f9d63}.sl-empty{text-align:center!important;color:var(--text-muted);padding:28px!important}
`;
