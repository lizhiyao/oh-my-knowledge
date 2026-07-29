import { defineConfig } from 'vitepress';

const GITHUB = 'https://github.com/lizhiyao/oh-my-knowledge';

// 落地页样式(landing.css)由 theme/Landing.vue 直接 import,经 Vite 的 CSS 管线在首次绘制前
// 进入 <head>(dev / 生产一致、无 FOUC)。规则均以 .omk-landing 限定,不污染文档页。

// 站点壳。内容源直接用既有 docs/（en 在根、zh 在 /zh/，正好对齐 VitePress i18n
// 约定）。第一刀只加首页 + 导航 / 侧栏 / 本地搜索，不重写任何文档正文。
export default defineConfig({
  title: 'OMK',
  description: 'OMK — Observe. Measure. Know. Evidence-backed knowledge changes for AI applications.',
  cleanUrls: true,
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
          { text: 'How-to', link: '/guides/agent-eval' },
          { text: 'Reference', link: '/reference/cli' },
          { text: 'Explanation', link: '/explanation/three-stage-workflow' },
          { text: 'Specs', link: '/specs/terminology-spec' },
        ],
        sidebar: [
          {
            text: 'Use omk',
            items: [
              { text: 'Quickstart', link: '/quickstart-skill-eval' },
              { text: 'CLI reference', link: '/reference/cli' },
              { text: 'Eval sample format', link: '/reference/eval-sample-format' },
              { text: 'Executors', link: '/reference/executors' },
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
              { text: 'Auto-improve a skill', link: '/guides/auto-improve-skills' },
              { text: 'Observe production traces', link: '/guides/observe-production' },
              { text: 'Reproduce Codex observation', link: '/guides/codex-observe-case' },
              { text: 'Use non-Claude models', link: '/guides/non-claude-models' },
            ],
          },
          {
            text: 'Understand how it works',
            items: [
              { text: 'Who omk is for', link: '/explanation/who-omk-is-for' },
              { text: 'The three stages', link: '/explanation/three-stage-workflow' },
              { text: 'Architecture', link: '/explanation/architecture' },
              { text: 'Statistical rigor', link: '/explanation/statistical-rigor' },
              { text: 'Scoring pipeline', link: '/specs/scoring' },
            ],
          },
          {
            text: 'Design specs',
            items: [
              { text: 'Sample design spec', link: '/specs/sample-design-spec' },
              { text: 'Knowledge gap signal spec', link: '/specs/knowledge-gap-signal-spec' },
              { text: 'RAG metrics spec', link: '/specs/rag-metrics-spec' },
              { text: 'Terminology spec', link: '/specs/terminology-spec' },
              { text: 'Storage layout spec', link: '/specs/storage-layout-spec' },
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
          { text: '操作指南', link: '/zh/guides/agent-eval' },
          { text: '参考', link: '/zh/reference/cli' },
          { text: '原理', link: '/zh/explanation/three-stage-workflow' },
          { text: '规范', link: '/zh/specs/terminology-spec' },
        ],
        sidebar: [
          {
            text: '我想用 omk',
            items: [
              { text: '快速上手', link: '/zh/quickstart-skill-eval' },
              { text: 'CLI 参考', link: '/zh/reference/cli' },
              { text: '评测用例格式', link: '/zh/reference/eval-sample-format' },
              { text: '执行器', link: '/zh/reference/executors' },
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
              { text: '自动迭代 skill', link: '/zh/guides/auto-improve-skills' },
              { text: '观测生产 trace', link: '/zh/guides/observe-production' },
              { text: '复现 Codex 父子任务观测', link: '/zh/guides/codex-observe-case' },
              { text: '使用非 Claude 模型', link: '/zh/guides/non-claude-models' },
            ],
          },
          {
            text: '我想懂工作原理',
            items: [
              { text: '为谁、解决什么', link: '/zh/explanation/who-omk-is-for' },
              { text: '三阶段', link: '/zh/explanation/three-stage-workflow' },
              { text: '工作原理', link: '/zh/explanation/architecture' },
              { text: '统计严谨性', link: '/zh/explanation/statistical-rigor' },
              { text: '评分公式', link: '/zh/specs/scoring' },
            ],
          },
          {
            text: '我想贡献 / 看设计 spec',
            items: [
              { text: '用例设计科学性指南', link: '/zh/specs/sample-design-spec' },
              { text: '知识缺口信号规范', link: '/zh/specs/knowledge-gap-signal-spec' },
              { text: 'RAG metrics 规范', link: '/zh/specs/rag-metrics-spec' },
              { text: '术语规范', link: '/zh/specs/terminology-spec' },
              { text: '存储布局规范', link: '/zh/specs/storage-layout-spec' },
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
