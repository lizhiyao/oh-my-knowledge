import { MEASURE_DETAIL_PREFIX } from '../../http/page-paths';

/**
 * 评测运行报告深链的单一 owner。
 *
 * `runId` 来自外部证据（落盘清单、受管事件），可以包含 `/` 等路径字符，必须整体编码：宿主侧
 * `src/studio/http/next-server.ts` 把 `/measure/` 之后仍带 `/` 的地址当作缺失路由直接 404，编码是
 * 读取契约的要求而不是防御性写法。语言不进地址：渲染语言只看本机设置（见 `src/studio/README.md`）。
 */
export function runReportHref(runId: string): string {
  return `${MEASURE_DETAIL_PREFIX}${encodeURIComponent(runId)}`;
}
