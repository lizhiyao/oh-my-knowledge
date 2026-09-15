/**
 * Studio 全站唯一的语义着色词表：只表达「好／需看／坏／本身不表达好坏」四档判断，
 * 不承载类别身份。受管生命周期的五档状态色是类别标记（见 `application/knowledge/managed-format.ts`
 * 的 `ManagedTone`），与本词表正交，不并入 —— 并成四档会让图例里两个条目共用一个圆点。
 *
 * antd 组件名映射只在 `web/components/tag-color.ts` 一处；色值只在 `web/app/studio.css`。
 */
export type StudioTone = 'success' | 'warning' | 'error' | 'neutral';
