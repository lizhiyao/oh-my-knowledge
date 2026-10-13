<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useData } from 'vitepress'
import zhHtml from './landing-body.html?raw'
import enHtml from './landing-body.en.html?raw'
import { initLanding } from './landing-init'
import './landing.css'

const isZh = useData().lang.value.startsWith('zh')
const landingHtml = isZh ? zhHtml : enHtml
const root = ref<HTMLElement>()
let dispose: (() => void) | null = null
onMounted(() => { if (root.value) dispose = initLanding(isZh ? 'zh' : 'en', root.value) })
onUnmounted(() => { if (dispose) { dispose(); dispose = null } })
</script>

<template>
  <main ref="root" class="omk-landing" tabindex="-1" v-html="landingHtml"></main>
</template>
