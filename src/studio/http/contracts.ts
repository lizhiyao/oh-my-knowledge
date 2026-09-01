import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import type { CoreStudioCatalog } from '../core-runs/index.js';

export interface ReportServerOptions {
  port?: number;
  /** 监听 host。默认 '127.0.0.1'（只允许本机访问，容器／远程场景看不到）。
   * 暴露到容器外／局域网用 '0.0.0.0'。也可走 OMK_REPORT_HOST 环境变量。 */
  host?: string;
  /** observe-health 报告目录，或一个按请求动态解析它的函数。 */
  analysesDir?: string | (() => string);
  /** 体检报告目录，或一个按请求动态解析它的函数。 */
  doctorsDir?: string | (() => string);
  observationsDir?: string;
  /** 受管目录，或一个按请求动态解析它的函数。 */
  managedDir?: string | (() => string);
  /** Source-neutral conversation inventory. Defaults to the local Codex catalog. */
  conversationCatalog?: ConversationCatalog;
  /** Evaluation 页面唯一事实源。提供后，/reports 与 /api/reports 只读 Core artifacts。 */
  coreStudioCatalog?: CoreStudioCatalog;
  /** 是否把别项目的 observe-health 索引卡片合进机器级总览。 */
  includeObserveCards?: boolean;
  /** 是否把别项目的 doctor 索引卡片合进机器级总览。 */
  includeDoctorCards?: boolean;
}

export interface ReportServer {
  start(): Promise<string>;
  stop(): Promise<void>;
  getUrl(): string | null;
}
