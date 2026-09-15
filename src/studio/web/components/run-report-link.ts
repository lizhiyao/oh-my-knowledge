import { langSuffix, type Language } from './layout/shell';

/**
 * 评测运行报告深链的单一 owner。
 *
 * `runId` 来自外部证据（落盘清单、受管事件），可以包含 `/` 等路径字符，必须整体编码：宿主侧
 * `src/studio/http/next-server.ts` 把 `/measure/` 之后仍带 `/` 的地址当作缺失路由直接 404，编码是
 * 读取契约的要求而不是防御性写法。语言由地址决定，静态链接一律显式带上 `lang`（见
 * `src/studio/README.md`），省略参数等于把用户本次的选择交回本机全局偏好。
 *
 * CLI 侧 `src/cli/lib/core-report-service.ts` 的绝对地址**不**走这里：它是交给用户浏览器的入口，
 * 刻意不带 `lang`，好让宿主按当次偏好决定语言。
 */
export function runReportHref(runId: string, lang: Language): string {
  return `/measure/${encodeURIComponent(runId)}${langSuffix(lang)}`;
}
