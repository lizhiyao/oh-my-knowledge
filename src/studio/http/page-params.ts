/**
 * Studio 地址查询参数的单一 owner。目前只有页签参数 `tab`。
 *
 * 为什么需要 owner：面板切换从组件本地状态变成地址的一部分之后，读的一侧是 `web/app/**` 的 RSC
 * 路由页，写的一侧是 `'use client'` 组件，两侧必须用同一个参数名和同一组取值。抄两遍时改一侧不会
 * 报错：地址写着 `?tab=source`，页面按自己的名字读不到，静默回到默认面板，而用户以为分享出去了。
 *
 * 为什么取值不能由组件拥有：RSC 只能 `import type` `'use client'` 模块（口径见
 * `test/architecture/studio-client-runtime-closure.test.ts`），所以面板键必须放在组件之外；两侧
 * 的一致性（键名与顺序）由 `test/architecture/studio-page-params.test.ts` 钉住。
 *
 * 为什么和 `page-paths.ts` 平级放在 `http/`、又不写进那个文件：参数和路径同属用户会粘贴出去的地址
 * 契约，但 `page-paths.ts` 的头注释划走了这条边界——它只放路径本身。把 `tab` 塞进去会违反它自己
 * 写的边界，所以另起一个叶子。
 *
 * 本模块零 import，和 `page-paths.ts` 同一理由：`'use client'` 组件按值取用它，任何反向依赖都会把
 * Node 宿主能力拖进浏览器 chunk（口径见 `test/architecture/studio-client-runtime-closure.test.ts`）。
 */

export const TAB_PARAM = 'tab';

/** 顺序即 `/observe/inbox` 上从左到右可见的面板顺序。 */
export const OBSERVE_INBOX_TABS = ['signals', 'skill-board', 'experience', 'metrics', 'timeline', 'action', 'chains'] as const;
export type ObserveInboxTab = (typeof OBSERVE_INBOX_TABS)[number];
export const DEFAULT_OBSERVE_INBOX_TAB: ObserveInboxTab = 'signals';

/** 顺序即任务轨迹页上从左到右可见的面板顺序。 */
export const TRAJECTORY_TABS = ['replay', 'knowledge', 'events', 'source'] as const;
export type TrajectoryTab = (typeof TRAJECTORY_TABS)[number];
export const DEFAULT_TRAJECTORY_TAB: TrajectoryTab = 'replay';

/**
 * 地址里的 `tab` 只认已知取值，其余一律回默认面板：宽松降级而不是报错。
 * 停在哪个面板不改变装载的数据（页面模型按地址路由组装载），所以一个陌生取值没有值得拒绝的语义。
 */
export function parseTab<T extends string>(raw: string | undefined, tabs: readonly T[], fallback: T): T {
  return tabs.find((tab) => tab === raw) ?? fallback;
}
