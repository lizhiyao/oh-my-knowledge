export function e(text: unknown): string {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function fmtNum(n: number | undefined | null, digits: number = 0): string {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function fmtCost(usd: number | undefined | null): string {
  return `$${Number(usd || 0).toFixed(4)}`;
}

export function fmtLocalTime(isoStr: string): string {
  const d = new Date(isoStr);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function delta(a: number | undefined | null, b: number | undefined | null, lowerIsBetter: boolean = false): string {
  if (!a || !b || a === 0) return '';
  const pct = ((b - a) / a * 100).toFixed(1);
  const better = lowerIsBetter ? b < a : b > a;
  const color = better ? 'var(--green)' : b === a ? 'var(--text-muted)' : 'var(--red)';
  const arrow = b > a ? '↑' : b < a ? '↓' : '→';
  return `<span style="color:${color};font-size:11px;margin-left:4px">${arrow}${Math.abs(Number(pct))}%</span>`;
}

interface BarChartItem {
  label: string;
  value: number;
  color: string;
}

export function barChart(items: BarChartItem[], maxVal: number): string {
  if (!maxVal || maxVal === 0) return '';
  return items.map(({ label, value, color }) => {
    const pct = Math.max(2, (value / maxVal) * 100);
    return `<div class="bar-row"><span class="bar-label">${e(label)}</span><div class="bar-fill" style="max-width:${pct}%;background:${color}"></div><span class="bar-value">${fmtNum(value)}</span></div>`;
  }).join('');
}

export const COLORS: string[] = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];
