/**
 * 跨域展示口径：绝对时间、百分比、耗时。这三件事原先在 application 与 web 两侧各有一份
 * 写法（整数／一位小数／全角百分号并存，`slice(0,19)`／`slice(0,16)`／直出 ISO 并存，
 * 四种耗时格式并存），同一状态因此在列表与详情里读成两个数。本模块是唯一 owner。
 *
 * application 的投影与 web 的组件都**按值** import 这里，所以本文件的运行时闭包必须保持
 * Node 无关（口径由 `test/architecture/studio-client-runtime-closure.test.ts` 钉住）；
 * 它也不产出中英文措辞，只产出语言无关的数字与时间文本。
 */

/**
 * ISO 时间戳的展示口径。`T` 换成空格、去掉小数秒，并且只在值确实以 `Z` 结尾时标注 `UTC`
 * （外部 trace 里的 `+08:00` 之类偏移不能被标成 UTC，原样保留偏移文字）。缺值统一给 `—`。
 * 不按服务器本地时区渲染：那会让同一条记录在不同机器上读出不同时刻。
 *
 * - `full`：到秒（默认）。
 * - `minute`：到分钟，用于行高受限的列表与卡片。
 * - `day`：只到日期，此时时区标注没有意义，一起去掉。
 * - `clock`：只到当日时刻，用于同一天内的密集时间轴。
 */
type TimePrecision = 'full' | 'minute' | 'day' | 'clock';

const ISO_PATTERN = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/** 时区标注：`Z` 显式写成 UTC，带偏移的保留偏移，无标记的不补。 */
function zoneLabel(raw: string | undefined): string {
  if (raw === undefined) return '';
  return raw === 'Z' ? ' UTC' : raw;
}

export function displayTime(value: string | undefined, precision: TimePrecision = 'full'): string {
  if (!value) return '—';
  const parts = ISO_PATTERN.exec(value);
  if (!parts) return value.replace('T', ' ');
  const [, date, hhmm, ss, zone] = parts;
  switch (precision) {
    case 'day':
      return date;
    case 'clock':
      return ss === undefined ? hhmm : `${hhmm}:${ss}`;
    case 'minute':
      return `${date} ${hhmm}${zoneLabel(zone)}`;
    case 'full':
      return `${date} ${hhmm}${ss === undefined ? '' : `:${ss}`}${zoneLabel(zone)}`;
  }
}

/**
 * 比率的展示文本：最多一位小数，整数值不补 `.0`（`100%`、`33.3%`），百分号一律半角 ——
 * 数字与单位是技术写法，中文文案的全角标点规则不覆盖它，全角 `％` 退出。
 * 缺值给 `—`，不把「未测得」读成 `0%`。
 */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${percentText(ratio * 100)}%`;
}

/** 比率差值：正数带 `+`，与 `formatPercent` 共用同一套舍入与字形。 */
export function formatPercentDelta(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  const text = percentText(ratio * 100);
  return `${ratio > 0 && text !== '0' ? '+' : ''}${text}%`;
}

/** 百分点数值 → 最多一位小数、整数不补 `.0`。 */
function percentText(points: number): string {
  const tenths = Math.round(points * 10) / 10;
  // 先归一 -0，否则 0 附近的负值会渲染成 "-0%"。
  const normalized = Object.is(tenths, -0) ? 0 : tenths;
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(1);
}

/**
 * 时长的展示文本：小于 1 秒出毫秒、小于 60 秒出一位小数秒（整数不补 `.0`）、以上出 `m`/`s`。
 * 单位是技术写法，中英文同一串。
 */
export function formatDuration(ms: number | null | undefined): string {
  const value = Number(ms ?? 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) {
    const tenths = Math.round(value / 100) / 10;
    return Number.isInteger(tenths) ? `${tenths}s` : `${tenths.toFixed(1)}s`;
  }
  let minutes = Math.floor(value / 60000);
  let seconds = Math.round((value % 60000) / 1000);
  // 秒单独四舍五入会凑出 "1m60s" 这种不存在的时刻：满 60 秒要进到分钟。
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}
