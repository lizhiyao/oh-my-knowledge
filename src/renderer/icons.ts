/**
 * 共享单色线性 SVG 图标集（替代各处 emoji）。
 *
 * 设计：统一 24×24 viewBox、`stroke="currentColor"`、单一描边权重、圆角端点。
 * 颜色由调用处的 CSS `color` 控制（图标自身不带色），尺寸/粗细可覆盖。
 * 之所以自带一套而不用图标库：报告是离线自包含 HTML，内联 SVG 无需外链/字体。
 */

/** name → viewBox 内的 path/shape 串。 */
const PATHS: Record<string, string> = {
  // 品牌 / 导航
  brand: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/>',
  home: '<path d="M3 10l9-7 9 7v9a2 2 0 01-2 2h-4v-6H9v6H5a2 2 0 01-2-2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chip: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12h8"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-left': '<path d="M15 18l-6-6 6-6"/>',

  // 报告类型（= 维度）
  doctor: '<path d="M3 12h4l2-6 4 14 2-8h6"/>',
  eval: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 11l2 2 4-4"/>',
  observe: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',

  // 六维
  fact: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  behavior: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  judge: '<path d="M21 12a8 8 0 01-11.5 7.2L4 21l1.8-5.5A8 8 0 1121 12z"/>',
  cost: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  efficiency: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  stability: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  quality: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',

  // 状态
  check: '<path d="M5 12l5 5L20 7"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  warn: '<path d="M12 9v4M12 17h.01M10.3 3.9l-8 14A2 2 0 004 21h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0012 2z"/>',
};

export type IconName = keyof typeof PATHS;

export interface IconOpts {
  /** 像素尺寸（宽高相同），默认 16。 */
  size?: number;
  /** 额外 class。 */
  cls?: string;
  /** 描边权重，默认 1.7。 */
  sw?: number;
  /** 内联 style。 */
  style?: string;
}

/** 返回一个自包含 `<svg>` 串。未知 name 返回空串（不抛错，调用处可安全拼接）。 */
export function icon(name: string, opts: IconOpts = {}): string {
  const p = PATHS[name];
  if (!p) return '';
  const size = opts.size ?? 16;
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  const style = opts.style ? ` style="${opts.style}"` : '';
  const sw = opts.sw ?? 1.7;
  return `<svg${cls}${style} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/** 维度 → 报告类型图标名。 */
export function dimIconName(dim: 'doctor' | 'eval' | 'observe'): IconName {
  return dim;
}
