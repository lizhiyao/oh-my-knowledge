import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import { useData } from 'vitepress'
import Landing from './Landing.vue'
import MermaidDiagram from './MermaidDiagram.vue'
import type { Theme } from 'vitepress'

// 首页进入 VPContent，复用导航、跳过导航和页脚的正确文档顺序。
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('MermaidDiagram', MermaidDiagram)
  },
  Layout() {
    const { frontmatter, lang } = useData()
    return h(
      DefaultTheme.Layout,
      null,
      frontmatter.value.landing ? { 'page-top': () => h(Landing, { key: lang.value }) } : {},
    )
  },
} satisfies Theme
