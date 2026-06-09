<script setup>
// omk 落地页 —— 与 omk-landing/index.html 视觉一致,中 / 英双语随站点 locale 切换。
// CSS 由 config.ts 的 transformHead 在该页 <head> 注入(SSR 即到位、页面级隔离);
// 这里只负责原样渲染对应语言的 HTML(v-html,inline onclick 在浏览器照常执行) + onMounted 跑交互 JS。
import { onMounted } from 'vue'
import { useData } from 'vitepress'
import zhHtml from './landing-body.html?raw'
import enHtml from './landing-body.en.html?raw'
import { initLanding } from './landing-init.js'
// 落地页样式。Landing.vue 由主题入口(theme/index.ts)同步 import,这条 CSS import 会在
// 应用挂载、首次绘制之前就把 <style> 注入 <head> —— dev / 生产一致,无 FOUC(大 logo 不再闪)。
// 规则全部 .omk-landing 限定,文档页虽载入但无元素命中,不污染。
import './landing.css'

// lang 为站点 locale 的语言标识(zh-Hans / en);落地页按 zh / en 二选一。
const isZh = useData().lang.value.startsWith('zh')
const landingHtml = isZh ? zhHtml : enHtml

onMounted(() => {
  initLanding(isZh ? 'zh' : 'en')
})
</script>

<template>
  <div class="omk-landing" v-html="landingHtml"></div>
</template>
