/**
 * Studio 页面地址的单一 owner。
 *
 * 同一批地址此前有三类 owner 各写一遍字面量：`next-server.ts` 判断宿主是否接管该路由组、
 * `http/pages/*-page.ts` 判断装载哪个页面模型、`web/components/**` 拼用户点的链接。三者必须
 * 一致却没有任何机制保证——改一处（例如把路由目录改名）只会让另一侧静默失效：链接指向宿主
 * 不再接管的地址，用户得到 HTTP adapter 的纯文本 404，而装载器与页面都还在。
 *
 * 本模块不 import 任何东西，这是刻意的：`web/components/**` 里有 `'use client'` 组件按值取用
 * 这些常量，而页面装载器按值依赖 application 的投影，会把 Node 内建能力拖进浏览器 chunk
 * （口径见 `test/architecture/studio-client-runtime-closure.test.ts`）。所以地址不能从装载器
 * 再导出一次，只能放在这个叶子上。
 *
 * 这里只放地址本身，不放语言参数：`lang` 由地址决定，拼链接时在调用点用 `langSuffix`
 * （见 `src/studio/README.md`），本模块保持零依赖。
 *
 * 每个常量都对应 `src/studio/web/app` 下真实存在的路由目录，由
 * `test/architecture/studio-page-paths.test.ts` 钉住；同一批字面量不得在 `src/studio` 其他
 * 文件里再出现一次，也由它钉住。
 */

export const OBSERVE_INDEX_PATH = '/observe';
export const OBSERVE_INBOX_PATH = '/observe/inbox';
export const OBSERVE_CONVERSATION_PREFIX = '/observe/conversations/';

export const HEALTH_INDEX_PATH = '/observe/health';
export const HEALTH_DIFF_PATH = '/observe/health-diff';
export const HEALTH_REPORT_PREFIX = '/observe/health/';
export const SKILL_TREND_PREFIX = '/observe/skill-trend/';

export const KNOWLEDGE_INDEX_PATH = '/knowledge';
export const KNOWLEDGE_CANDIDATES_PATH = '/knowledge/candidates';
export const KNOWLEDGE_SKILL_PREFIX = '/knowledge/skills/';
export const MANAGED_LIST_PATH = '/knowledge/managed';
export const MANAGED_DETAIL_PREFIX = '/knowledge/managed/';

export const MEASURE_INDEX_PATH = '/measure';
export const MEASURE_DETAIL_PREFIX = '/measure/';
