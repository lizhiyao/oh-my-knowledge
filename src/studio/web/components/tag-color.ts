/**
 * 语义 tone → antd Tag 状态色。各域（体检、收件箱看板、复盘优先级）用的是同一组 tone 字面量，
 * 只此一份映射，避免同一档在两个表格里渲染成两种底色。
 *
 * `neutral` 必须落到 `default`：它不是 antd 的 preset/status 色名，直接传给 Tag 会被当作自定义
 * 色值解析出一条近灰的填充色，与「样本不足／无异常，不给硬色」的口径不一致。
 * 严重度用 `info` 而非 `success`，词表不同，映射留在 signals.tsx。
 */
type TagTone = 'success' | 'warning' | 'error' | 'neutral';
type TagStatus = 'success' | 'warning' | 'error' | 'default';

const STATUS: Record<TagTone, TagStatus> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  neutral: 'default',
};

export function tagStatus(tone: TagTone): TagStatus {
  return STATUS[tone];
}
