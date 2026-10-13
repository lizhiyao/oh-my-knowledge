import { defineConfig } from 'vitepress';
import { pageHref, pageRoute } from './page-links.js';

const GITHUB = 'https://github.com/lizhiyao/oh-my-knowledge';

// 落地页样式(landing.css)由 theme/Landing.vue 直接 import,经 Vite 的 CSS 管线在首次绘制前
// 进入 <head>(dev / 生产一致、无 FOUC)。规则均以 .omk-landing 限定,不污染文档页。

// 站点壳。内容源直接用既有 docs/（en 在根、zh 在 /zh/，正好对齐 VitePress i18n
// 约定）。第一刀只加首页 + 导航 / 侧栏 / 本地搜索，不重写任何文档正文。
export default defineConfig({
  title: 'OMK',
  description: 'OMK — Observe. Measure. Know. Build knowledge from collaboration between people and AI.',
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
          { text: 'Quickstart', link: '/quickstart-skill-eval' },
          { text: 'Guides', link: '/README' },
          { text: 'Reference', link: '/reference/cli' },
          { text: 'Explanation', link: '/explanation/' },
          { text: 'Specs', link: '/specs/' },
        ],
        sidebar: [
          {
            text: 'Use omk',
            items: [
              { text: 'Quickstart', link: '/quickstart-skill-eval' },
              { text: 'Migrate to the 1.0 preview', link: '/guides/v1-preview-migration' },
              { text: 'CLI reference', link: '/reference/cli' },
              { text: 'Use in a Node.js service', link: '/guides/eval-runtime' },
              { text: 'Integrate as a platform host', link: '/guides/platform-host-integration' },
              { text: 'Runtime API reference', link: '/reference/eval-runtime-api' },
              { text: 'Core API (advanced)', link: '/reference/embedded-api' },
              { text: 'Eval sample format', link: '/reference/eval-sample-format' },
              { text: 'Executors', link: '/reference/executors' },
              { text: 'Global settings', link: '/reference/settings' },
              { text: 'Artifact & variant layout', link: '/reference/artifact-layout' },
              { text: 'Comparison with 7 tools', link: '/reference/comparison' },
              { text: 'Glossary', link: '/reference/glossary' },
            ],
          },
          {
            text: 'How-to guides',
            items: [
              { text: 'Run doctor checks', link: '/guides/run-doctor-checks' },
              { text: 'Evaluate an agent', link: '/guides/agent-eval' },
              { text: 'Sample design', link: '/specs/sample-design-spec' },
              { text: 'Auto-improve a skill', link: '/guides/auto-improve-skills' },
              { text: 'Observe & inspect task trajectories', link: '/guides/observe-production' },
              { text: 'Extract candidate knowledge', link: '/guides/extract-knowledge' },
              { text: 'Compose the ChatGPT MCP integration', link: '/guides/mcp-integration' },
              { text: 'Reproduce Codex observation', link: '/guides/codex-observe-case' },
              { text: 'Use non-Claude models', link: '/guides/non-claude-models' },
            ],
          },
          {
            text: 'Understand how it works',
            items: [
              { text: 'Principles and responsibilities', link: '/explanation/' },
              { text: 'How OMK understands knowledge', link: '/explanation/knowledge' },
              { text: 'Who omk is for', link: '/explanation/who-omk-is-for' },
              { text: 'The three stages', link: '/explanation/three-stage-workflow' },
              { text: 'Architecture', link: '/explanation/architecture' },
              { text: 'Statistical rigor', link: '/explanation/statistical-rigor' },
            ],
          },
          {
            text: 'Design specs',
            items: [
              { text: 'Index and reading order', link: '/specs/' },
              { text: 'Contributing guide', link: '/guides/contributing' },
              {
                text: 'Shared boundaries',
                collapsed: true,
                items: [
                  { text: 'Terminology', link: '/specs/terminology-spec' },
                  { text: 'Storage layout', link: '/specs/storage-layout-spec' },
                ],
              },
              {
                text: 'Entity identity and extraction',
                collapsed: true,
                items: [
                  { text: 'Entity extraction: evidence and limits', link: '/specs/entities/' },
                  { text: 'Entity identity', link: '/specs/entity-identity' },
                  { text: 'Entity extraction', link: '/specs/entity-extraction' },
                  { text: 'Extraction evaluation', link: '/specs/entity-extraction-evaluation' },
                ],
              },
              {
                text: 'Knowledge construction and maintenance',
                collapsed: true,
                items: [
                  { text: 'Knowledge domain model (draft)', link: '/specs/knowledge-domain-model' },
                  { text: 'Entity knowledge library', link: '/specs/knowledge-library' },
                ],
              },
              {
                text: 'Controlled evaluation',
                collapsed: true,
                items: [
                  { text: 'Evaluation Core vNext', link: '/specs/eval-core-vnext' },
                  { text: 'CLI input compilation', link: '/specs/cli-evaluation-input-compilation' },
                  { text: 'Runtime Adapter', link: '/specs/evaluation-runtime-adapter' },
                  { text: 'Artifact persistence', link: '/specs/evaluation-artifact-persistence' },
                  { text: 'Studio projection', link: '/specs/evaluation-studio-projection' },
                  { text: 'Scoring equivalence', link: '/specs/evaluation-scoring-equivalence' },
                  { text: 'Scoring pipeline', link: '/specs/scoring' },
                  { text: 'RAG metrics', link: '/specs/rag-metrics-spec' },
                  { text: 'General sample proposal (historical)', link: '/specs/general-sample-proposal' },
                ],
              },
              {
                text: 'Observation signals',
                collapsed: true,
                items: [
                  { text: 'Knowledge-gap signals (partly delivered)', link: '/specs/knowledge-gap-signal-spec' },
                  { text: 'Effective observation review', link: '/explanation/effective-observation-review' },
                ],
              },
              {
                text: 'Studio hosts and data flow',
                collapsed: true,
                items: [
                  { text: 'Studio specifications and history', link: '/specs/studio/' },
                  { text: 'Studio data flow', link: '/explanation/studio-data-flow' },
                  { text: 'Studio performance baseline (historical)', link: '/explanation/studio-performance-baseline' },
                ],
              },
            ],
          },
        ],
        footer: {
          message: 'Learn more · <a href="/quickstart-skill-eval">Quickstart</a> · <a href="/reference/cli">CLI reference</a> · <a href="https://github.com/lizhiyao/oh-my-knowledge">GitHub</a> · <a href="https://www.npmjs.com/package/oh-my-knowledge">npm</a>',
          copyright: 'MIT Licensed · © OMK',
        },
      },
    },

    zh: {
      label: '简体中文',
      lang: 'zh-Hans',
      link: '/zh/',
      themeConfig: {
        nav: [
          { text: '快速上手', link: '/zh/quickstart-skill-eval' },
          { text: '使用指南', link: '/zh/README' },
          { text: '参考', link: '/zh/reference/cli' },
          { text: '原理', link: '/zh/explanation/' },
          { text: '规范', link: '/zh/specs/' },
        ],
        sidebar: [
          {
            text: '我想用 omk',
            items: [
              { text: '快速上手', link: '/zh/quickstart-skill-eval' },
              { text: '迁移到 1.0 预览版', link: '/zh/guides/v1-preview-migration' },
              { text: 'CLI 参考', link: '/zh/reference/cli' },
              { text: '在 Node.js 服务中使用', link: '/zh/guides/eval-runtime' },
              { text: '平台宿主集成（评测中心类）', link: '/zh/guides/platform-host-integration' },
              { text: 'Runtime API 参考', link: '/zh/reference/eval-runtime-api' },
              { text: '底层 Core API（高级）', link: '/zh/reference/embedded-api' },
              { text: '评测用例格式', link: '/zh/reference/eval-sample-format' },
              { text: '执行器', link: '/zh/reference/executors' },
              { text: '全局设置与配置范围', link: '/zh/reference/settings' },
              { text: '指定被测对象(artifact / variant)', link: '/zh/reference/artifact-layout' },
              { text: '7 工具对比', link: '/zh/reference/comparison' },
              { text: '术语表', link: '/zh/reference/glossary' },
            ],
          },
          {
            text: '操作指南',
            items: [
              { text: 'doctor 体检', link: '/zh/guides/run-doctor-checks' },
              { text: '评测 agent', link: '/zh/guides/agent-eval' },
              { text: '用例设计', link: '/zh/specs/sample-design-spec' },
              { text: '自动迭代 skill', link: '/zh/guides/auto-improve-skills' },
              { text: '观测与任务轨迹', link: '/zh/guides/observe-production' },
              { text: '从日志提炼候选知识', link: '/zh/guides/extract-knowledge' },
              { text: '组合 ChatGPT MCP 集成', link: '/zh/guides/mcp-integration' },
              { text: '复现 Codex 父子任务观测', link: '/zh/guides/codex-observe-case' },
              { text: '使用非 Claude 模型', link: '/zh/guides/non-claude-models' },
            ],
          },
          {
            text: '我想懂工作原理',
            items: [
              { text: '原理索引与职责边界', link: '/zh/explanation/' },
              { text: 'OMK 如何理解知识', link: '/zh/explanation/knowledge' },
              { text: '为谁、解决什么', link: '/zh/explanation/who-omk-is-for' },
              { text: '三阶段', link: '/zh/explanation/three-stage-workflow' },
              { text: '工作原理', link: '/zh/explanation/architecture' },
              { text: '统计严谨性', link: '/zh/explanation/statistical-rigor' },
            ],
          },
          {
            text: '设计规范',
            items: [
              { text: '规范索引与阅读顺序', link: '/zh/specs/' },
              { text: '贡献指南', link: '/zh/guides/contributing' },
              {
                text: '共享边界',
                collapsed: true,
                items: [
                  { text: '术语规范', link: '/zh/specs/terminology-spec' },
                  { text: '存储布局', link: '/zh/specs/storage-layout-spec' },
                ],
              },
              {
                text: '实体身份与提取',
                collapsed: true,
                items: [
                  { text: '实体提取：证据与限制', link: '/zh/specs/entities/' },
                  { text: '实体身份', link: '/zh/specs/entity-identity' },
                  { text: '实体提取', link: '/zh/specs/entity-extraction' },
                  { text: '实体提取评测', link: '/zh/specs/entity-extraction-evaluation' },
                ],
              },
              {
                text: '知识建设与维护',
                collapsed: true,
                items: [
                  { text: '知识领域模型（草案）', link: '/zh/specs/knowledge-domain-model' },
                  { text: '实体知识库', link: '/zh/specs/knowledge-library' },
                ],
              },
              {
                text: '受控评测',
                collapsed: true,
                items: [
                  { text: 'Evaluation Core vNext', link: '/zh/specs/eval-core-vnext' },
                  { text: 'CLI 输入编译', link: '/zh/specs/cli-evaluation-input-compilation' },
                  { text: 'Runtime Adapter', link: '/zh/specs/evaluation-runtime-adapter' },
                  { text: '产物持久化', link: '/zh/specs/evaluation-artifact-persistence' },
                  { text: 'Studio 投影', link: '/zh/specs/evaluation-studio-projection' },
                  { text: '评分等价性', link: '/zh/specs/evaluation-scoring-equivalence' },
                  { text: '评分管道', link: '/zh/specs/scoring' },
                  { text: 'RAG 指标', link: '/zh/specs/rag-metrics-spec' },
                  { text: '通用用例提案（历史）', link: '/zh/specs/general-sample-proposal' },
                ],
              },
              {
                text: '观测信号',
                collapsed: true,
                items: [
                  { text: '知识缺口信号（部分交付）', link: '/zh/specs/knowledge-gap-signal-spec' },
                  { text: '有效观测复核', link: '/zh/explanation/effective-observation-review' },
                ],
              },
              {
                text: 'Studio 宿主与数据流',
                collapsed: true,
                items: [
                  { text: 'Studio 规范与历史记录', link: '/zh/specs/studio/' },
                  { text: 'Studio 数据流', link: '/zh/explanation/studio-data-flow' },
                  { text: 'Studio 性能基线（历史）', link: '/zh/explanation/studio-performance-baseline' },
                ],
              },
            ],
          },
        ],
        docFooter: { prev: '上一页', next: '下一页' },
        outline: { label: '本页目录' },
        lastUpdatedText: '最后更新',
        returnToTopLabel: '回到顶部',
        footer: {
          message: '了解更多 · <a href="/zh/quickstart-skill-eval">快速上手</a> · <a href="/zh/reference/cli">CLI 参考</a> · <a href="https://github.com/lizhiyao/oh-my-knowledge">GitHub</a> · <a href="https://www.npmjs.com/package/oh-my-knowledge">npm</a>',
          copyright: 'MIT Licensed · © OMK',
        },
      },
    },
  },
});
