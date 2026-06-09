import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import { useData } from 'vitepress'
import Landing from './Landing.vue'

// frontmatter `landing: true` 的页面:沿用 VitePress 默认主题(顶栏 + 页脚),
// 落地内容经 `layout-top` 槽位全宽插在导航与页脚之间。其它页面照常走默认主题。
export default {
  extends: DefaultTheme,
  Layout() {
    const { frontmatter } = useData()
    return h(
      DefaultTheme.Layout,
      null,
      frontmatter.value.landing ? { 'layout-top': () => h(Landing) } : {},
    )
  },
}
