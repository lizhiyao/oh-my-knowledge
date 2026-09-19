/**
 * tone → antd Tag 色名。web 层只有这一处点名 antd 的 Tag 颜色：同一档状态在两个表格里渲染成
 * 两种底色，用户就会读成两个结论。色值（十六进制）不在这里，只在 `web/app/studio.css` 的
 * `--tone-*` / `--managed-tone-*` 变量里；本文件只负责「用哪个 antd 色名」。
 *
 * 三套词表按各自的 owner 分开，不并成一套：
 *  - `StudioTone`：跨页语义色（成功／告警／错误／中性），健康度、稳定性、优先级都用它。
 *  - `ManagedTone`：受管生命周期的分类色板，多出的 `accent`／`muted` 表达「证据就绪」「已纳管」
 *    这类事实，不是好坏档位。
 *  - `SignalSeverityTone`：收件箱严重度，低优先级是 `info` 而不是 `success`。
 *
 * `neutral` 必须落到 `default`：它不是 antd 的 preset/status 色名，直接传给 Tag 会被当作自定义
 * 色值解析出一条近灰的填充色，与「样本不足／无异常，不给硬色」的口径不一致。
 */
import type { SignalSeverityTone } from '../../../observability/presentation';
import type { ManagedTone } from '../../application/knowledge/managed-format';
import type { StudioTone } from '../../view-models/display/tone';

/** antd Tag 认得的色名；上面三套词表都靠这些名字落地。 */
type TagColor = 'success' | 'warning' | 'error' | 'processing' | 'default';

const STUDIO: Record<StudioTone, TagColor> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  neutral: 'default',
};

const MANAGED: Record<ManagedTone, TagColor> = {
  green: 'success',
  yellow: 'warning',
  red: 'error',
  accent: 'processing',
  muted: 'default',
};

const SEVERITY: Record<SignalSeverityTone, TagColor> = {
  error: 'error',
  warning: 'warning',
  info: 'processing',
  neutral: 'default',
};

export function tagStatus(tone: StudioTone): TagColor {
  return STUDIO[tone];
}

export function managedTagColor(tone: ManagedTone): TagColor {
  return MANAGED[tone];
}

export function severityTagColor(tone: SignalSeverityTone): TagColor {
  return SEVERITY[tone];
}
