<script setup>
// omk 落地页 —— 与 omk-landing/index.html 视觉一致,中 / 英双语随站点 locale 切换。
// CSS 由下方 `import './landing.css'`(经 Vite,主题入口同步 import、首绘前注入 <head>,
// 规则全部 .omk-landing 限定)负责;这里只负责原样渲染对应语言的 HTML(v-html,inline onclick
// 照常执行) + onMounted 跑交互 JS,onUnmounted 清理定时器/observer 防泄漏。
import { onMounted, onUnmounted } from 'vue'
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

let dispose = null
onMounted(() => { dispose = initLanding(isZh ? 'zh' : 'en') })
onUnmounted(() => { if (dispose) { dispose(); dispose = null } })
</script>

<template>
  <div class="omk-landing" v-html="landingHtml"></div>
</template>
