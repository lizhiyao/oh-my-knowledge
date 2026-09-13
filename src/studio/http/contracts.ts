import type { KnowledgeQuery } from '../application/knowledge-query.js';
import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import type { CoreStudioCatalog } from '../view-models/core-runs.js';

export interface ReportServerOptions {
  /** Shared knowledge query for page and API adapters, scoped to this server. */
  knowledgeQuery?: KnowledgeQuery;
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
  /** Evaluation 页面唯一事实源。提供后，/measure 与 /api/reports 只读 Core artifacts。 */
  coreStudioCatalog?: CoreStudioCatalog;
  /** 是否把别项目的 observe-health 索引卡片合进机器级总览。 */
  includeObserveCards?: boolean;
  /** 是否把别项目的 doctor 索引卡片合进机器级总览。 */
  includeDoctorCards?: boolean;
  /**
   * 是否提供观测收件箱路由组（页面 /observe/inbox 与 API /api/observe-inbox/*）。默认 true。
   * 页面与 API 由同一个开关裁剪：Next 宿主据此决定是否接管 /observe/inbox，
   * report-server 据此决定是否注册 API 路由组。
   * 数据层 observability/inbox 与 CLI observe 子命令不受影响。
   */
  observationInbox?: boolean;
  /**
   * 是否挂载 Studio 观测／知识页面组（HTML 路由与 Next 侧对应的接管集合）。默认 true。
   * 传 false 只保留评测预览必需的 /health、/api/shutdown 与 /api/reports：/measure 页面由
   * Next 宿主提供，report-server 层不再持有对应的 HTML 路由。
   * 用于 CLI 评测预览宿主——它按设计只服务本次运行的 /measure 报告页。
   * 壳层的一级导航由同一个开关裁剪：不挂页面组的宿主没有可去的兄弟路由，渲染导航等于把用户导向 404。
   */
  studioPages?: boolean;
}

export interface ReportServer {
  start(): Promise<string>;
  stop(): Promise<void>;
  getUrl(): string | null;
}
