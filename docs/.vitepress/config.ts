import { defineConfig } from 'vitepress';
import { pageHref, pageRoute } from './page-links.js';

const GITHUB = 'https://github.com/lizhiyao/oh-my-knowledge';

// 落地页样式(landing.css)由 theme/Landing.vue 直接 import,经 Vite 的 CSS 管线在首次绘制前
// 进入 <head>(dev / 生产一致、无 FOUC)。规则均以 .omk-landing 限定,不污染文档页。

// 文档源按领域组织；pageRoute 保留既有公开地址，页面按语言提供 metadata。
export default defineConfig({
  title: 'OMK',
  description: 'OMK helps people and agents build, maintain, and reuse valuable knowledge from real work and collaboration, with readable content, traceable sources, and ongoing revisions for future tasks.',
  cleanUrls: true,
  rewrites: pageRoute,
  markdown: {
    config(md) {
      const link = md.renderer.rules.link_open!;
      md.renderer.rules.link_open = (tokens, index, options, env, self) => {
        const token = tokens[index];
        const href = token.attrGet('href');
        if (href && env.path) token.attrSet('href', pageHref(href, env));
        return link(tokens, index, options, env, self);
      };
      const fence = md.renderer.rules.fence!
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index]
        if (token.info.trim() === 'mermaid') {
          const source = md.utils.escapeHtml(JSON.stringify(token.content))
          return `<MermaidDiagram :source="${source}" />`
        }
        return fence(tokens, index, options, env, self)
      }
    },
  },
  lastUpdated: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]],

  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [{ icon: 'github', link: GITHUB }],
    search: { provider: 'local' },
  },

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Maintain knowledge', link: '/guides/extract-knowledge' },
          { text: 'Evaluate', link: '/quickstart-skill-eval' },
          { text: 'Guides', link: '/README' },
          { text: 'Reference', link: '/reference/cli' },
          { text: 'Explanation', link: '/explanation/' },
          { text: 'Specs', link: '/specs/' },
        ],
        sidebar: [
          {
            text: "Start with a task",
            collapsed: false,
            items: [
              { text: "Documentation start", link: "/README" },
              { text: "Inspect real tasks", link: "/guides/observe/" },
              { text: "Accumulate and maintain knowledge", link: "/guides/knowledge/" },
              { text: "Verify carrier changes", link: "/guides/evaluation/" },
            ],
          },
          {
            text: "Knowledge accumulation and maintenance",
            collapsed: true,
            items: [
              { text: "Knowledge maintenance workflow", link: "/guides/extract-knowledge" },
              { text: "Review knowledge quality", link: "/guides/review-knowledge-quality" },
              { text: "SDK maintenance case", link: "/guides/sdk-maintenance-case" },
              { text: "Extraction evidence and semantic review", link: "/guides/verify-extraction-study" },
              { text: "Extraction storage example", link: "https://github.com/lizhiyao/oh-my-knowledge/blob/main/examples/knowledge-extraction/README.md" },
              { text: "Knowledge principles", link: "/explanation/knowledge" },
              { text: "Knowledge specifications", link: "/specs/knowledge/" },
            ],
          },
          {
            text: "Observation and review",
            collapsed: true,
            items: [
              { text: "Studio and observation", link: "/guides/observe-production" },
              { text: "Codex source case", link: "/guides/codex-observe-case" },
              { text: "Observation specifications", link: "/specs/observe/" },
            ],
          },
          {
            text: "Controlled evaluation",
            collapsed: true,
            items: [
              { text: "Quickstart", link: "/quickstart-skill-eval" },
              { text: "Sample design", link: "/specs/sample-design-spec" },
              { text: "Doctor checks", link: "/guides/run-doctor-checks" },
              { text: "Agents and project context", link: "/guides/agent-eval" },
              { text: "Local task acceptance", link: "/guides/local-tasks" },
              { text: "Iterate candidates", link: "/guides/auto-improve-skills" },
            ],
          },
          {
            text: "Service and Agent integration",
            collapsed: true,
            items: [
              { text: "Integration reading entry", link: "/guides/integration/" },
              { text: "Compare two versions in code", link: "/guides/service-evaluation" },
              { text: "Platform hosts", link: "/guides/platform-host-integration" },
              { text: "MCP feedback", link: "/guides/mcp-integration" },
              { text: "Models and endpoints", link: "/guides/non-claude-models" },
            ],
          },
          {
            text: "Look up as needed",
            collapsed: true,
            items: [
              { text: "CLI", link: "/reference/cli" },
              { text: "Shared reference", link: "/reference/shared/" },
              { text: "Evaluation reference", link: "/reference/evaluation/" },
              { text: "Integration reference and full configuration", link: "/reference/integration/" },
            ],
          },
          {
            text: "Principles and concepts",
            collapsed: true,
            items: [
              { text: "Principles index", link: "/explanation/" },
              { text: "Product scope", link: "/explanation/who-omk-is-for" },
              { text: "Architecture", link: "/explanation/architecture" },
              { text: "Statistics and conclusions", link: "/explanation/statistical-rigor" },
              { text: "Related tools and tasks", link: "/reference/comparison" },
            ],
          },
          {
            text: "Implementation specifications",
            collapsed: true,
            items: [
              { text: "Specification index", link: "/specs/" },
              { text: "Shared names and storage", link: "/specs/shared/" },
              { text: "Entity identity and extraction", link: "/specs/entities/" },
              { text: "Knowledge construction and maintenance", link: "/specs/knowledge/" },
              { text: "Evaluation contracts and wiring", link: "/specs/evaluation/" },
              { text: "Observation and review", link: "/specs/observe/" },
              { text: "Studio hosts and data flow", link: "/specs/studio/" },
            ],
          },
          {
            text: "Upgrade and contribute",
            collapsed: true,
            items: [
              { text: "Upgrade entry", link: "/guides/maintenance/" },
              { text: "Contributing", link: "/guides/contributing" },
            ],
          },
        ],
        footer: {
          message: 'Learn more · <a href="/guides/extract-knowledge">Maintain knowledge</a> · <a href="/reference/cli">CLI reference</a> · <a href="https://github.com/lizhiyao/oh-my-knowledge">GitHub</a> · <a href="https://www.npmjs.com/package/oh-my-knowledge">npm</a>',
          copyright: 'MIT Licensed · © OMK',
        },
      },
    },

    zh: {
      label: '简体中文',
      lang: 'zh-Hans',
      description: 'OMK 帮助人和 Agent 沉淀、维护并复用有价值的知识，将真实工作与协作中的认识、方法和判断依据整理为可读、可追溯、可持续修订的知识，供后续任务使用。',
      link: '/zh/',
      themeConfig: {
        nav: [
          { text: '维护知识', link: '/zh/guides/extract-knowledge' },
          { text: '直接评测', link: '/zh/quickstart-skill-eval' },
          { text: '使用指南', link: '/zh/README' },
          { text: '参考', link: '/zh/reference/cli' },
          { text: '原理', link: '/zh/explanation/' },
          { text: '规范', link: '/zh/specs/' },
        ],
        sidebar: [
          {
            text: "从任务开始",
            collapsed: false,
            items: [
              { text: "文档入口", link: "/zh/README" },
              { text: "查看真实任务", link: "/zh/guides/observe/" },
              { text: "积累与维护知识", link: "/zh/guides/knowledge/" },
              { text: "验证载体改动", link: "/zh/guides/evaluation/" },
            ],
          },
          {
            text: "知识积累与维护",
            collapsed: true,
            items: [
              { text: "知识维护完整动线", link: "/zh/guides/extract-knowledge" },
              { text: "核对知识质量", link: "/zh/guides/review-knowledge-quality" },
              { text: "SDK 维护案例", link: "/zh/guides/sdk-maintenance-case" },
              { text: "提炼证据与语义复核", link: "/zh/guides/verify-extraction-study" },
              { text: "知识提取存储示例", link: "https://github.com/lizhiyao/oh-my-knowledge/blob/main/examples/knowledge-extraction/README.zh.md" },
              { text: "知识原理", link: "/zh/explanation/knowledge" },
              { text: "知识领域规范", link: "/zh/specs/knowledge/" },
            ],
          },
          {
            text: "观测与复核",
            collapsed: true,
            items: [
              { text: "Studio 与观测", link: "/zh/guides/observe-production" },
              { text: "Codex 来源案例", link: "/zh/guides/codex-observe-case" },
              { text: "观测规范", link: "/zh/specs/observe/" },
            ],
          },
          {
            text: "受控评测",
            collapsed: true,
            items: [
              { text: "快速上手", link: "/zh/quickstart-skill-eval" },
              { text: "用例设计", link: "/zh/specs/sample-design-spec" },
              { text: "doctor 体检", link: "/zh/guides/run-doctor-checks" },
              { text: "Agent 与项目上下文", link: "/zh/guides/agent-eval" },
              { text: "本地任务验收", link: "/zh/guides/local-tasks" },
              { text: "自动迭代候选", link: "/zh/guides/auto-improve-skills" },
            ],
          },
          {
            text: "服务与 Agent 集成",
            collapsed: true,
            items: [
              { text: "集成阅读入口", link: "/zh/guides/integration/" },
              { text: "在代码里比较两个版本", link: "/zh/guides/service-evaluation" },
              { text: "平台宿主", link: "/zh/guides/platform-host-integration" },
              { text: "MCP 反馈", link: "/zh/guides/mcp-integration" },
              { text: "模型与端点", link: "/zh/guides/non-claude-models" },
            ],
          },
          {
            text: "按需查阅",
            collapsed: true,
            items: [
              { text: "CLI", link: "/zh/reference/cli" },
              { text: "通用参考", link: "/zh/reference/shared/" },
              { text: "评测参考", link: "/zh/reference/evaluation/" },
              { text: "接入参考与完整配置", link: "/zh/reference/integration/" },
            ],
          },
          {
            text: "原理与概念",
            collapsed: true,
            items: [
              { text: "原理索引", link: "/zh/explanation/" },
              { text: "产品使用范围", link: "/zh/explanation/who-omk-is-for" },
              { text: "架构", link: "/zh/explanation/architecture" },
              { text: "统计与结论", link: "/zh/explanation/statistical-rigor" },
              { text: "同类工具与任务", link: "/zh/reference/comparison" },
            ],
          },
          {
            text: "实现规范",
            collapsed: true,
            items: [
              { text: "规范索引", link: "/zh/specs/" },
              { text: "共享命名与存储", link: "/zh/specs/shared/" },
              { text: "实体身份与提取", link: "/zh/specs/entities/" },
              { text: "知识建设与维护", link: "/zh/specs/knowledge/" },
              { text: "评测契约与接线", link: "/zh/specs/evaluation/" },
              { text: "观测与复核", link: "/zh/specs/observe/" },
              { text: "Studio 宿主与数据流", link: "/zh/specs/studio/" },
            ],
          },
          {
            text: "升级与贡献",
            collapsed: true,
            items: [
              { text: "升级入口", link: "/zh/guides/maintenance/" },
              { text: "贡献流程", link: "/zh/guides/contributing" },
            ],
          },
        ],
        docFooter: { prev: '上一页', next: '下一页' },
        outline: { label: '本页目录' },
        lastUpdatedText: '最后更新',
        returnToTopLabel: '回到顶部',
        footer: {
          message: '了解更多 · <a href="/zh/guides/extract-knowledge">维护知识</a> · <a href="/zh/reference/cli">CLI 参考</a> · <a href="https://github.com/lizhiyao/oh-my-knowledge">GitHub</a> · <a href="https://www.npmjs.com/package/oh-my-knowledge">npm</a>',
          copyright: 'MIT Licensed · © OMK',
        },
      },
    },
  },
});
