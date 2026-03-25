export function e(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function fmtNum(n, digits = 0) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function fmtCost(usd) {
  return `$${Number(usd || 0).toFixed(4)}`;
}

export function fmtLocalTime(isoStr) {
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function delta(a, b, lowerIsBetter = false) {
  if (!a || !b || a === 0) return '';
  const pct = ((b - a) / a * 100).toFixed(1);
  const better = lowerIsBetter ? b < a : b > a;
  const color = better ? '#16a34a' : b === a ? '#6b7280' : '#dc2626';
  const arrow = b > a ? '↑' : b < a ? '↓' : '→';
  return `<span style="color:${color};font-size:12px;margin-left:4px">${arrow}${Math.abs(pct)}%</span>`;
}

export function barChart(items, maxVal) {
  if (!maxVal || maxVal === 0) return '';
  return items.map(({ label, value, color }) => {
    const pct = Math.max(2, (value / maxVal) * 100);
    return `<div style="margin:4px 0"><span style="display:inline-block;width:50px;font-size:12px;color:#6b7280">${e(label)}</span><div style="display:inline-block;width:${pct}%;background:${color};height:18px;border-radius:3px;vertical-align:middle"></div><span style="font-size:12px;margin-left:6px">${fmtNum(value)}</span></div>`;
  }).join('');
}

export const COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];
