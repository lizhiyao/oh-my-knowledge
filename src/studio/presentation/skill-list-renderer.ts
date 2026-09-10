import { DEFAULT_LANG, e, layout } from './layout.js';
import { assessHealth } from '../application/skill-health.js';
import type { Lang } from '../../shared/language.js';
import type { SkillIndex } from '../view-models/skill-index.js';

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
    return `<tr data-band="${health.color}"><td><a href="/knowledge/skills/${encodeURIComponent(entry.skillName)}${langQ}">${e(entry.skillName)}</a></td><td><span class="sl-band sl-band--${health.color}">${e(health.label)}</span>${health.score === null ? '' : ` <strong>${health.score}</strong>`}</td><td>${e(doctorText)}</td><td>${e(observeText)}</td><td>${insights.length}</td><td>${e(dateText(updatedAt))}</td></tr>`;
  }).join('');
  return layout(zh ? '知识健康工作台' : 'Knowledge health', `<main class="studio-page"><h1 class="studio-page-title">${zh ? '知识' : 'Knowledge'}</h1><div class="studio-page-body"><section class="sl-summary"><span>${index.summary.totalSkills} ${zh ? '个知识对象' : 'knowledge artifacts'}</span><span class="sl-red">${index.summary.red} ${zh ? '红' : 'red'}</span><span class="sl-yellow">${index.summary.yellow} ${zh ? '黄' : 'yellow'}</span><span class="sl-green">${index.summary.green} ${zh ? '绿' : 'green'}</span></section><section class="sl-card" tabindex="0" role="region" aria-label="${zh ? '知识列表' : 'Knowledge list'}"><table><thead><tr><th>Skill</th><th>${zh ? '健康' : 'Health'}</th><th>Doctor</th><th>Observe</th><th>${zh ? '问题' : 'Findings'}</th><th>${zh ? '更新时间' : 'Updated'}</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="sl-empty">${zh ? '尚无 doctor 或 observe 数据。' : 'No doctor or observe data yet.'}</td></tr>`}</tbody></table></section></div></main><style>${CSS}</style>`, lang, { navigation: 'knowledge', workspace: true });
}

const CSS = `
.sl-summary{flex-shrink:0;display:flex;flex-wrap:wrap;gap:18px;margin-bottom:12px;font-size:13px;color:var(--text-secondary)}.sl-red{color:#dc2626}.sl-yellow{color:#d97706}.sl-green{color:#1f9d63}.sl-card{flex:1;min-height:0;overscroll-behavior:contain;overflow:auto;background:#fff;border:1px solid var(--border);border-radius:6px}.sl-card table{width:100%;border-collapse:collapse}.sl-card th,.sl-card td{padding:9px 12px;text-align:left;border-bottom:1px solid #eef1f6;white-space:nowrap}.sl-card th{font-size:11px;color:var(--text-muted);text-transform:uppercase}.sl-card td{font-size:13px}.sl-card td:first-child a{font-weight:650;color:var(--text-primary);text-decoration:none}.sl-band{display:inline-block;border-radius:10px;padding:2px 8px;background:#f1f3f6;color:#637083}.sl-band--red{background:#fef2f2;color:#dc2626}.sl-band--yellow{background:#fff7ed;color:#d97706}.sl-band--green{background:#ecfdf5;color:#1f9d63}.sl-empty{text-align:center!important;color:var(--text-muted);padding:36px!important}
`;
