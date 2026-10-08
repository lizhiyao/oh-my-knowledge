/**
 * Studio 全站唯一的语义着色词表：只表达「好／需看／坏／本身不表达好坏」四档判断，
 * 不承载类别身份。
 *
 * antd 组件名映射只在 `web/components/tag-color.ts` 一处；色值只在 `web/app/studio.css`。
 */
export type StudioTone = 'success' | 'warning' | 'error' | 'neutral';
