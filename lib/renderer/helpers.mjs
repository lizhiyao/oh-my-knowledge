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
  const color = better ? '#4ade80' : b === a ? '#64748b' : '#f87171';
  const arrow = b > a ? '↑' : b < a ? '↓' : '→';
  return `<span style="color:${color};font-size:12px;margin-left:4px">${arrow}${Math.abs(pct)}%</span>`;
}

export function barChart(items, maxVal) {
  if (!maxVal || maxVal === 0) return '';
  return items.map(({ label, value, color }) => {
    const pct = Math.max(2, (value / maxVal) * 100);
    return `<div style="margin:6px 0"><span style="display:inline-block;width:60px;font-size:12px;color:#64748b">${e(label)}</span><div style="display:inline-block;width:${pct}%;background:linear-gradient(90deg,${color},${color}88);height:20px;border-radius:5px;vertical-align:middle"></div><span style="font-size:12px;margin-left:8px;color:#94a3b8">${fmtNum(value)}</span></div>`;
  }).join('');
}

export const COLORS = ['#818cf8', '#fbbf24', '#34d399', '#f87171', '#a78bfa', '#f472b6'];
