import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import { useData } from 'vitepress'
import Landing from './Landing.vue'
import KnowledgeExplainer from './KnowledgeExplainer.vue'

// frontmatter `landing: true` 的页面:沿用 VitePress 默认主题(顶栏 + 页脚),
// 落地内容经 `layout-top` 槽位全宽插在导航与页脚之间。其它页面照常走默认主题。
export default {
  extends: DefaultTheme,
  Layout() {
    const { frontmatter, lang } = useData()
    // key 绑定 lang:中英首页都是 landing 页、共用同一 layout-top 槽位,SPA 切换语言时
    // Vue 会复用同一个 Landing 实例导致内容停在旧语言;key 变化强制重新挂载,
    // 让 setup 按新 locale 重算 HTML、onMounted 重跑交互 JS。
    let layoutTop
    if (frontmatter.value.landing) {
      layoutTop = () => h(Landing, { key: lang.value })
    } else if (frontmatter.value.knowledgeExplainer) {
      layoutTop = () => h(KnowledgeExplainer, { key: lang.value })
    }

    return h(DefaultTheme.Layout, null, layoutTop ? { 'layout-top': layoutTop } : {})
  },
}
